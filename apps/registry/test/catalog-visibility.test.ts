import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import type { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type BetterAuthHandle, createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"

/**
 * Catalog visibility filter on the LIST endpoint (architecture §4.5,
 * VAL-AUTH-003, VAL-PUB-016).
 *
 * Background: registry-core scrutiny surfaced a latent gap in
 * `GET /v1/modules` — the list endpoint had no visibility WHERE
 * clause. It was invisible only because the seed catalog was all
 * `public`. Once `POST /v1/publish` (the publish-endpoint feature)
 * can create `org`-visibility modules, the list MUST filter them
 * out for callers who cannot prove org membership, matching the
 * detail endpoint's 404 semantics (existence is not leaked).
 *
 * Identity model:
 *   - anonymous (no credential): visibility='public' only
 *   - authenticated non-member: visibility='public' only
 *   - authenticated member of the owning org: visibility='public'
 *     AND visibility='org' for orgs where the caller has a row in
 *     Better-Auth's `member` table
 *
 * Membership is checked via Better-Auth's `member` table directly
 * (the same lookup the detail endpoint uses); role does not need
 * to be owner / admin — any member role qualifies for visibility.
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
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-visibility-"))
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

/**
 * Seeds two modules under a freshly-created `acme` org: one with
 * `visibility: 'public'` and one with `visibility: 'org'`. Returns
 * the org id so tests can confirm membership state. Idempotent so
 * a re-run against the same data dir leaves the seeded rows alone
 * (the unique `(scope, name)` constraint would otherwise reject
 * the second `INSERT`).
 */
async function seedOrgVisibilityFixture(fx: Stack): Promise<{ acmeOrgId: string }> {
	const acmeOrgId = (
		await fx.pglite.query<{ id: string }>(
			`INSERT INTO "organization" (id, name, slug, plan, "createdAt")
			   VALUES (gen_random_uuid(), 'Acme', 'acme', 'free', NOW())
			 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
			 RETURNING id`,
		)
	).rows[0]?.id
	if (!acmeOrgId) throw new Error("seedOrgVisibilityFixture: failed to insert acme org")

	await fx.pglite.query(
		`INSERT INTO modules (scope, name, visibility, tier, description)
		   VALUES ('acme', 'public-mod', 'public', 'community-screened', 'a public community module'),
		          ('acme', 'private-mod', 'org', 'community-unverified', 'an org-only module')
		 ON CONFLICT (scope, name) DO NOTHING`,
	)
	await fx.pglite.query(
		`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status)
		   SELECT id, '1.0.0', repeat('0', 40), repeat('a', 64),
		          '{"name":"placeholder","version":"1.0.0","description":"","dependencies":[],"conflictsWith":[],"actions":[{"id":"x","description":"","params":[]}],"moduleValidators":[]}'::jsonb,
		          'ready'
		     FROM modules WHERE scope = 'acme'
		   ON CONFLICT DO NOTHING`,
	)

	return { acmeOrgId }
}

async function addMember(fx: Stack, userId: string, orgId: string, role: string): Promise<void> {
	await fx.pglite.query(
		`INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
		   VALUES (gen_random_uuid()::text, $1, $2, $3, NOW())
		 ON CONFLICT DO NOTHING`,
		[userId, orgId, role],
	)
}

describe("GET /v1/modules — visibility filter (registry-core scrutiny regression)", () => {
	let fx: Stack
	beforeEach(async () => {
		fx = await buildStack()
		await seedOrgVisibilityFixture(fx)
	})
	afterEach(async () => {
		await fx.close()
	})

	it("anonymous callers see only public modules (acme/private-mod is hidden)", async () => {
		const res = await fx.app.request("/v1/modules")
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			modules: Array<{ scope: string; name: string; visibility: string }>
		}
		const names = body.modules.map((m) => `${m.scope}/${m.name}`).sort()
		expect(names).toEqual(["acme/public-mod"])
	})

	it("an authenticated non-member sees only public modules (the org-private one is hidden)", async () => {
		const outsider = await signUp(fx, "outsider@example.com", "password-12345")
		const outsiderKey = await createApiKey(fx, outsider.sessionCookie, "outsider-key")

		const res = await fx.app.request("/v1/modules", {
			headers: { "x-api-key": outsiderKey.key },
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			modules: Array<{ scope: string; name: string; visibility: string }>
		}
		const names = body.modules.map((m) => `${m.scope}/${m.name}`).sort()
		expect(names).toEqual(["acme/public-mod"])
	})

	it("an authenticated member of the org sees their org-private modules too", async () => {
		const member = await signUp(fx, "member@example.com", "password-12345")
		const acmeOrgId = (await fx.pglite.query<{ id: string }>(`SELECT id FROM "organization" WHERE slug = 'acme'`))
			.rows[0]?.id
		if (!acmeOrgId) throw new Error("missing acme org in fixture")
		await addMember(fx, member.userId, acmeOrgId, "member")
		const memberKey = await createApiKey(fx, member.sessionCookie, "member-key")

		const res = await fx.app.request("/v1/modules", {
			headers: { "x-api-key": memberKey.key },
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			modules: Array<{ scope: string; name: string; visibility: string }>
		}
		const names = body.modules.map((m) => `${m.scope}/${m.name}`).sort()
		expect(names).toEqual(["acme/private-mod", "acme/public-mod"])
	})

	it("the visibility filter on the LIST endpoint matches the 404 semantics on the DETAIL endpoint", async () => {
		// anonymous — same exclusion rule applies to both routes.
		const list = await fx.app.request("/v1/modules")
		const listBody = (await list.json()) as { modules: Array<{ scope: string; name: string }> }
		const listHasPrivate = listBody.modules.some((m) => m.scope === "acme" && m.name === "private-mod")
		expect(listHasPrivate).toBe(false)

		const detail = await fx.app.request("/v1/modules/acme/private-mod")
		expect(detail.status).toBe(404)
		const detailBody = (await detail.json()) as { error?: string }
		expect(detailBody.error).toContain("acme/private-mod")
	})

	it("an org admin's membership also reveals org-private modules (any role counts, not just owner)", async () => {
		const admin = await signUp(fx, "admin@example.com", "password-12345")
		const acmeOrgId = (await fx.pglite.query<{ id: string }>(`SELECT id FROM "organization" WHERE slug = 'acme'`))
			.rows[0]?.id
		if (!acmeOrgId) throw new Error("missing acme org in fixture")
		await addMember(fx, admin.userId, acmeOrgId, "admin")
		const adminKey = await createApiKey(fx, admin.sessionCookie, "admin-key")

		const res = await fx.app.request("/v1/modules", {
			headers: { "x-api-key": adminKey.key },
		})
		const body = (await res.json()) as {
			modules: Array<{ scope: string; name: string; visibility: string }>
		}
		const names = body.modules.map((m) => `${m.scope}/${m.name}`).sort()
		expect(names).toEqual(["acme/private-mod", "acme/public-mod"])
	})

	it("?tier= filter composes with the visibility filter — a public module at the requested tier is shown, a private one is not", async () => {
		const res = await fx.app.request("/v1/modules?tier=community-screened")
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			modules: Array<{ scope: string; name: string; tier: string }>
		}
		const names = body.modules.map((m) => `${m.scope}/${m.name}`).sort()
		expect(names).toEqual(["acme/public-mod"])
	})

	it("Cache-Control: no-store is preserved on the visibility-filtered response", async () => {
		const res = await fx.app.request("/v1/modules")
		expect(res.headers.get("cache-control")).toBe("no-store")
	})
})
