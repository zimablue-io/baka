import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import type { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type BetterAuthHandle, createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { ensureOfficialOrg } from "../src/auth/official-org"
import { ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { loadConfig } from "../src/config"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"
import { startServer } from "../src/server"

/**
 * Official-org bootstrap integration tests (architecture §8 decisions
 * 26 and 29).
 *
 * Each test boots a fresh PGlite + Better-Auth + Hono stack so the
 * `organization` and `member` tables are never shared across cases.
 * The fixture exposes the same email/password sign-up surface as
 * the orgs feature so tests can mint an API key for a real user and
 * assert that the listed publisher (the API key) is granted owner
 * role on the official org via `ensureOfficialOrg`.
 *
 * The bootstrap itself is data-driven — the test calls
 * `ensureOfficialOrg(pglite, config)` directly after booting
 * the stack, which is the same path `startServer` executes at boot.
 * The boot-flow integration is covered by the explicit `startServer`
 * test at the bottom of the file.
 */

interface Stack {
	app: Hono
	betterAuth: BetterAuthHandle
	pglite: PGlite
	socket: PGLiteSocketServer
	baseUrl: string
	dataDir: string
	pgliteDir: string
	close: () => Promise<void>
}

async function pickEphemeralPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = net.createServer()
		probe.on("error", reject)
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address()
			if (typeof addr !== "object" || addr === null) {
				probe.close()
				reject(new Error("could not pick ephemeral port"))
				return
			}
			const port = addr.port
			probe.close(() => resolve(port))
		})
	})
}

async function buildStack(): Promise<Stack> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-official-"))
	const pgliteDir = join(dataDir, "pg")
	const socketPort = await pickEphemeralPort()

	const pglite = await PGlite.create(pgliteDir)
	await applyAppMigrations(pglite)
	const socket = new PGLiteSocketServer({
		db: pglite,
		port: socketPort,
		host: "127.0.0.1",
		maxConnections: 10,
	})
	await socket.start()

	const pool = createPgPool({ port: socketPort, host: "127.0.0.1" })
	const baseUrl = `http://127.0.0.1:${socketPort + 1}`
	const betterAuth = await createBetterAuth(pool, {
		baseUrl,
		githubClientId: "test-github-client-id",
		githubClientSecret: "test-github-client-secret",
		secret: "test-secret-do-not-use-in-production",
		emailAndPassword: { enabled: true },
	})
	await betterAuth.ensureTables()

	// App migrations run before Better-Auth bootstraps, so the
	// `organization.plan` column could not be added by 0004_orgs_plan
	// at first boot. Apply it now (matches the production server.ts
	// boot order). Idempotent on subsequent boots.
	await ensureOrgPlanColumn(pglite)

	const app = buildApp({ auth: betterAuth.auth, pglite, officialOrg: "baka" })

	return {
		app,
		betterAuth,
		pglite,
		socket,
		baseUrl,
		dataDir,
		pgliteDir,
		close: async () => {
			await betterAuth.close().catch(() => {})
			await socket.stop().catch(() => {})
			await pglite.close().catch(() => {})
			rmSync(dataDir, { recursive: true, force: true })
		},
	}
}

async function signUp(fx: Stack, email: string, password: string): Promise<{ userId: string; sessionCookie: string }> {
	const res = await fx.app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", origin: fx.baseUrl },
		body: JSON.stringify({ email, password, name: email }),
	})
	if (res.status !== 200) {
		throw new Error(`sign-up failed for ${email}: ${res.status} ${await res.text()}`)
	}
	const body = (await res.json()) as { user: { id: string } }
	const setCookie = res.headers.get("set-cookie") ?? ""
	const sessionCookie = extractBetterAuthCookie(setCookie)
	if (!sessionCookie) {
		throw new Error(`sign-up did not return a session cookie for ${email}`)
	}
	return { userId: body.user.id, sessionCookie }
}

async function createApiKey(fx: Stack, sessionCookie: string, name: string): Promise<{ id: string; key: string }> {
	const res = await fx.app.request("/api/auth/api-key/create", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: fx.baseUrl,
			cookie: sessionCookie,
		},
		body: JSON.stringify({ name }),
	})
	if (res.status !== 200) {
		throw new Error(`create-api-key failed: ${res.status} ${await res.text()}`)
	}
	return (await res.json()) as { id: string; key: string }
}

function extractBetterAuthCookie(setCookie: string): string {
	const parts = setCookie.split(/,(?=\s*[^\s]+=)/)
	const pairs: string[] = []
	for (const raw of parts) {
		const seg = raw.trim()
		const eq = seg.indexOf("=")
		if (eq <= 0) continue
		const name = seg.slice(0, eq).trim()
		if (name === "better-auth.session_token" || name === "__Secure-better-auth.session_token") {
			pairs.push(seg.split(";")[0])
		}
	}
	return pairs.join("; ")
}

async function orgExists(fx: Stack, slug: string): Promise<boolean> {
	const rows = await fx.pglite.query<{ id: string }>(`SELECT id FROM "organization" WHERE slug = $1`, [slug])
	return rows.rows.length > 0
}

async function memberRole(fx: Stack, userId: string, slug: string): Promise<string | null> {
	const rows = await fx.pglite.query<{ role: string }>(
		`SELECT m.role
		   FROM "member" m
		   JOIN "organization" o ON o.id = m."organizationId"
		  WHERE o.slug = $1
		    AND m."userId" = $2`,
		[slug, userId],
	)
	return rows.rows[0]?.role ?? null
}

// ----------------------------------------------------------------------------
// ensureOfficialOrg — direct unit-style behavioral tests
// ----------------------------------------------------------------------------

describe("ensureOfficialOrg — idempotent org creation", () => {
	let fx: Stack
	beforeEach(async () => {
		fx = await buildStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("creates the official org if absent", async () => {
		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
		})
		expect(result.created).toBe(true)
		expect(await orgExists(fx, "baka")).toBe(true)
	})

	it("is idempotent — a second call does not duplicate the org", async () => {
		await ensureOfficialOrg(fx.pglite, { officialOrg: "baka" })
		const result = await ensureOfficialOrg(fx.pglite, { officialOrg: "baka" })
		expect(result.created).toBe(false)
		const rows = await fx.pglite.query<{ id: string }>(`SELECT id FROM "organization" WHERE slug = $1`, ["baka"])
		expect(rows.rows).toHaveLength(1)
	})

	it("uses the configured REGISTRY_OFFICIAL_ORG slug (not hardcoded 'baka')", async () => {
		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "myhub",
		})
		expect(result.created).toBe(true)
		expect(await orgExists(fx, "myhub")).toBe(true)
		expect(await orgExists(fx, "baka")).toBe(false)
	})

	it("rejects an empty slug with an honest error", async () => {
		await expect(ensureOfficialOrg(fx.pglite, { officialOrg: "" })).rejects.toThrow(/non-empty/)
	})
})

describe("ensureOfficialOrg — publisher authority", () => {
	let fx: Stack
	beforeEach(async () => {
		fx = await buildStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("grants owner role to a user whose API key is listed", async () => {
		const alice = await signUp(fx, "alice@example.com", "password-12345")
		const aliceKey = await createApiKey(fx, alice.sessionCookie, "alice-key")

		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: aliceKey.key,
		})
		expect(result.publishersGranted).toBe(1)
		expect(result.publishersFailed).toBe(0)
		expect(await memberRole(fx, alice.userId, "baka")).toBe("owner")
	})

	it("grants owner role to multiple listed publishers at once", async () => {
		const alice = await signUp(fx, "alice@example.com", "password-12345")
		const bob = await signUp(fx, "bob@example.com", "password-12345")
		const aliceKey = await createApiKey(fx, alice.sessionCookie, "alice-key")
		const bobKey = await createApiKey(fx, bob.sessionCookie, "bob-key")

		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: `${aliceKey.key},${bobKey.key}`,
		})
		expect(result.publishersGranted).toBe(2)
		expect(await memberRole(fx, alice.userId, "baka")).toBe("owner")
		expect(await memberRole(fx, bob.userId, "baka")).toBe("owner")
	})

	it("reports invalid API keys as failed (not a 500 to the caller)", async () => {
		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: "definitely-not-a-real-key",
		})
		expect(result.publishersGranted).toBe(0)
		expect(result.publishersFailed).toBe(1)
		expect(result.publishers[0]?.error).toBeDefined()
	})

	it("grants owner role when the GitHub user ID matches accountId", async () => {
		const alice = await signUp(fx, "alice@example.com", "password-12345")
		await fx.pglite.query(
			`INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
			 VALUES (gen_random_uuid(), $1, 'github', $2, NOW(), NOW())`,
			["123456", alice.userId],
		)

		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: "github:123456",
		})

		expect(result.publishersGranted).toBe(1)
		expect(result.publishersFailed).toBe(0)
		expect(await memberRole(fx, alice.userId, "baka")).toBe("owner")
	})

	it("skips GitHub user IDs that do not match any existing account", async () => {
		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: "github:999999",
		})
		expect(result.publishersGranted).toBe(0)
		expect(result.publishers[0]?.resolved).toBe("github-user-id")
		expect(result.publishers[0]?.error).toBeUndefined()
	})

	it("treats an empty publishers list as 'no publishers' (org still created, no members added)", async () => {
		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: "",
		})
		expect(result.created).toBe(true)
		expect(result.publishersGranted).toBe(0)
		expect(result.publishers).toHaveLength(0)
	})

	it("treats an unset publishers list as 'no publishers'", async () => {
		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
		})
		expect(result.created).toBe(true)
		expect(result.publishersGranted).toBe(0)
	})

	it("upgrades an existing member to owner role if already a member", async () => {
		// Sign up alice + create a key, then bootstrap once to make
		// her owner. Re-bootstrapping with the same key MUST keep
		// her owner role (not downgrade to member) and create
		// exactly one member row.
		const alice = await signUp(fx, "alice@example.com", "password-12345")
		const aliceKey = await createApiKey(fx, alice.sessionCookie, "alice-key")

		await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: aliceKey.key,
		})

		// Now manually downgrade alice to member to simulate a
		// prior membership from elsewhere.
		await fx.pglite.query(
			`UPDATE "member" SET role = 'member'
			   WHERE "userId" = $1
			     AND "organizationId" = (SELECT id FROM "organization" WHERE slug = 'baka')`,
			[alice.userId],
		)
		expect(await memberRole(fx, alice.userId, "baka")).toBe("member")

		// Re-run bootstrap with the same key — must reset to owner.
		await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: aliceKey.key,
		})
		expect(await memberRole(fx, alice.userId, "baka")).toBe("owner")

		// Exactly one member row for alice on the official org.
		const rows = await fx.pglite.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count
			   FROM "member"
			  WHERE "userId" = $1
			    AND "organizationId" = (SELECT id FROM "organization" WHERE slug = 'baka')`,
			[alice.userId],
		)
		expect(rows.rows[0]?.count).toBe("1")
	})

	it("supports `key:` prefix to force interpretation as API key", async () => {
		// A user with a GitHub-style name is forced to be an API-key
		// lookup. The apiKey verify rejects the garbage value, so
		// the publisher is reported as failed rather than treated
		// as a GitHub publisher identity.
		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: "key:github-tools",
		})
		expect(result.publishersGranted).toBe(0)
		expect(result.publishersFailed).toBe(1)
		expect(result.publishers[0]?.resolved).toBe("api-key")
	})

	it("trims whitespace around comma-separated entries", async () => {
		const alice = await signUp(fx, "alice@example.com", "password-12345")
		const aliceKey = await createApiKey(fx, alice.sessionCookie, "alice-key")

		const result = await ensureOfficialOrg(fx.pglite, {
			officialOrg: "baka",
			officialPublishers: `  ${aliceKey.key}  ,  `,
		})
		expect(result.publishersGranted).toBe(1)
		expect(await memberRole(fx, alice.userId, "baka")).toBe("owner")
	})
})

// ----------------------------------------------------------------------------
// Boot flow — startServer wires ensureOfficialOrg into the bootstrap
// ----------------------------------------------------------------------------

describe("startServer — official-org bootstrap is wired into the boot", () => {
	let dataDir: string
	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "baka-registry-official-boot-"))
	})
	afterEach(async () => {
		rmSync(dataDir, { recursive: true, force: true })
	})

	function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
		return {
			PORT: "0",
			BASE_URL: "http://localhost:4300",
			DATA_DIR: dataDir,
			STORAGE_DIR: "artifacts",
			PGLITE_DIR: "pg",
			PGLITE_SOCKET_PORT: "5444",
			REGISTRY_OFFICIAL_ORG: "baka",
			...overrides,
		}
	}

	it("startServer creates the official org on boot", async () => {
		const config = loadConfig(env(), dataDir)
		const handle = await startServer(config)
		try {
			expect(handle.database).toBeDefined()
			const rows = await handle.database.pglite.query<{ slug: string }>(
				`SELECT slug FROM "organization" WHERE slug = 'baka'`,
			)
			expect(rows.rows).toHaveLength(1)
		} finally {
			await handle.close()
		}
	})

	it("logs skipped GitHub publishers during boot", async () => {
		const output: string[] = []
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
			return true
		})
		const config = loadConfig(env({ REGISTRY_OFFICIAL_PUBLISHERS: "github:999999" }), dataDir)
		const handle = await startServer(config)
		try {
			expect(output.join("")).toContain("GitHub publisher(s) skipped")
			expect(output.join("")).toContain("github:999999")
		} finally {
			await handle.close()
			writeSpy.mockRestore()
		}
	})

	it("startServer uses the configured REGISTRY_OFFICIAL_ORG when set", async () => {
		const config = loadConfig(env({ REGISTRY_OFFICIAL_ORG: "myhub" }), dataDir)
		const handle = await startServer(config)
		try {
			const rows = await handle.database.pglite.query<{ slug: string }>(
				`SELECT slug FROM "organization" WHERE slug = 'myhub'`,
			)
			expect(rows.rows).toHaveLength(1)
			const bakaRows = await handle.database.pglite.query<{ slug: string }>(
				`SELECT slug FROM "organization" WHERE slug = 'baka'`,
			)
			expect(bakaRows.rows).toHaveLength(0)
		} finally {
			await handle.close()
		}
	})
})
