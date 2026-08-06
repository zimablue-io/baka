import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import type { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type BetterAuthHandle, createBetterAuth, parseApiKeyRateLimitEnv } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"

/**
 * Registry hardening batch (publishing-ingest, registry-core scrutiny
 * synthesis). Five behavioral pins the new code must keep observable:
 *
 *  1. `resolveIdentity` never throws on a malformed credential —
 *     auth-gated `/v1/*` routes must answer 401 (not 500) for any
 *     credential shape Better-Auth rejects.
 *
 *  2. The 403 → 401 translator in `auth/handlers.ts` only rewrites
 *     credential-rejection codes (INVALID_API_KEY / MISSING_API_KEY /
 *     …); role and origin 403s pass through as 403. This is the
 *     `isCredentialRejectionCode` convention from `org-routes.ts`,
 *     now applied uniformly to `/api/auth/*`.
 *
 *  3. Migration `0002_app_schema` survives a mid-apply crash on a
 *     fresh data dir: a partial set of tables + the `app_migrations`
 *     row not yet recorded means the next boot re-runs the SQL,
 *     every CREATE uses IF NOT EXISTS, the boot completes, and the
 *     full schema is in place.
 *
 *  4. The `@better-auth/api-key` plugin's rate limit is env-
 *     configurable (`REGISTRY_API_KEY_RATE_LIMIT*`); the default is
 *     unchanged when unset (upstream 10 / 24h).
 *
 *  5. `DELETE /v1/orgs/:slug` works when the client sends no body and
 *     no content-type: the registry-built JSON body is forwarded
 *     with `content-type: application/json` so Better-Auth's router
 *     does not reject with 415.
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
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-hardening-"))
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

async function createApiKey(
	fx: Stack,
	sessionCookie: string,
	opts: { name?: string } = {},
): Promise<{ id: string; key: string }> {
	const res = await fx.app.request("/api/auth/api-key/create", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: fx.baseUrl,
			cookie: sessionCookie,
		},
		body: JSON.stringify({ name: opts.name ?? "test-key" }),
	})
	if (res.status !== 200) {
		throw new Error(`create-api-key failed: ${res.status} ${await res.text()}`)
	}
	return (await res.json()) as { id: string; key: string }
}

// ----------------------------------------------------------------------------
// Fix #1 — resolveIdentity never throws; /v1/* routes never 500 on bad creds
// ----------------------------------------------------------------------------

describe("resolveIdentity never throws on malformed credentials", () => {
	let fx: Stack
	beforeEach(async () => {
		fx = await buildStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("POST /v1/publish with a malformed x-api-key returns 401, not 500", async () => {
		// The contract is "401 not 500": resolveIdentity is wrapped in
		// try-catch specifically so the apiKey plugin's FORBIDDEN on a
		// malformed key cannot bubble up as a 500 to the auth-gated
		// /v1/publish endpoint.
		const res = await fx.app.request("/v1/publish", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": "this-is-not-a-valid-key-shape",
			},
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(401)
		expect(res.status).not.toBe(500)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
		const body = (await res.json()) as { error?: string }
		expect(typeof body.error).toBe("string")
	})

	it("POST /v1/publish with a syntactically valid but never-issued x-api-key returns 401, not 500", async () => {
		const res = await fx.app.request("/v1/publish", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": "baka_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
			},
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(401)
		expect(res.status).not.toBe(500)
	})

	it("POST /v1/publish with no credential at all returns 401, not 500", async () => {
		const res = await fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", origin: fx.baseUrl },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(401)
		expect(res.status).not.toBe(500)
	})

	it("the server stays up after a malformed-credential 401 and serves subsequent requests", async () => {
		await fx.app.request("/v1/publish", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": "garbage",
			},
			body: JSON.stringify({}),
		})

		// Subsequent authenticated request succeeds — the throw path
		// did not take down the server.
		const { sessionCookie } = await signUp(fx, "healthy@example.com", "password-12345")
		const ok = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { cookie: sessionCookie, origin: fx.baseUrl },
		})
		expect(ok.status).toBe(200)
	})
})

// ----------------------------------------------------------------------------
// Fix #2 — 403 → 401 translator only fires for credential-rejection codes
// ----------------------------------------------------------------------------

describe("handlers.ts 403→401 translator uses code-checking, not blanket rewrite", () => {
	let fx: Stack
	let owner: { userId: string; sessionCookie: string; apiKey: string }
	let member: { userId: string; sessionCookie: string; apiKey: string }
	let orgId: string

	beforeEach(async () => {
		fx = await buildStack()
		const ownerEmail = "owner@example.com"
		const memberEmail = "member@example.com"
		const ownerSession = await signUp(fx, ownerEmail, "password-12345")
		const memberSession = await signUp(fx, memberEmail, "password-12345")
		const ownerKey = await createApiKey(fx, ownerSession.sessionCookie, { name: "owner-key" })
		const memberKey = await createApiKey(fx, memberSession.sessionCookie, { name: "member-key" })
		owner = { ...ownerSession, apiKey: ownerKey.key }
		member = { ...memberSession, apiKey: memberKey.key }

		// Owner creates acme and invites the member.
		const created = await fx.app.request("/v1/orgs", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": owner.apiKey,
			},
			body: JSON.stringify({ name: "Acme", slug: "acme" }),
		})
		expect(created.status).toBe(200)
		const createdBody = (await created.json()) as { id: string }
		orgId = createdBody.id

		const invite = await fx.app.request("/v1/orgs/acme/invite", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": owner.apiKey,
			},
			body: JSON.stringify({ email: memberEmail, role: "member" }),
		})
		expect(invite.status).toBe(200)
		const inviteBody = (await invite.json()) as { id: string }

		const accept = await fx.app.request("/v1/orgs/acme/accept-invitation", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": member.apiKey,
			},
			body: JSON.stringify({ invitationId: inviteBody.id }),
		})
		expect(accept.status).toBe(200)
	})
	afterEach(async () => {
		await fx.close()
	})

	it("a malformed API key on /api/auth/* returns 401 (credential-rejection path)", async () => {
		// The apiKey plugin rejects an unknown key with a credential-
		// rejection code (INVALID_API_KEY). handlers.ts must rewrite
		// that to 401 — the api-key surface is honestly distinct from
		// the cookie surface, and a missing/garbage key is an
		// authentication failure, not a permission decision.
		const res = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": "not-a-real-key", origin: fx.baseUrl },
		})
		expect(res.status).toBe(401)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
	})

	it("a member calling Better-Auth's role-protected /api/auth/organization/update returns 403 (NOT translated to 401)", async () => {
		// The member's api-key is VALID (so credential rejection
		// doesn't fire). Better-Auth's organization-update permission
		// is admin+, so the member gets a 403 from a permission
		// decision (no body code, or a non-credential-rejection
		// code). handlers.ts MUST pass the 403 through — translating
		// it to 401 would lie about what failed.
		const res = await fx.app.request("/api/auth/organization/update", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": member.apiKey,
			},
			body: JSON.stringify({
				data: { name: "Should Not Happen" },
				organizationId: orgId,
			}),
		})
		expect(res.status).toBe(403)
		expect(res.status).not.toBe(401)
	})

	it("a member calling Better-Auth's /api/auth/organization/delete returns 403 (NOT translated to 401)", async () => {
		// Owner-only delete; member has a valid key but lacks the
		// role. The 403 from Better-Auth's ACL must pass through.
		const res = await fx.app.request("/api/auth/organization/delete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": member.apiKey,
			},
			body: JSON.stringify({ organizationId: orgId }),
		})
		expect(res.status).toBe(403)
		expect(res.status).not.toBe(401)
	})

	it("a cookie-only 403 from the origin middleware still passes through (no api key ⇒ no rewrite)", async () => {
		// origin-middleware rejection: a mutating request carries a
		// session cookie (no api key) and an evil.example origin.
		// Better-Auth returns 403 because the origin does not match
		// `trustedOrigins`. The handlers.ts mount MUST leave the
		// response alone — no api key was presented, so the
		// credential-rejection rewrite branch never runs.
		// (GET /api/auth/get-session does not pass through the origin
		// middleware — origin checks apply to mutating requests.)
		const evilOrigin = "https://evil.example"
		const res = await fx.app.request("/v1/orgs", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: evilOrigin,
				cookie: owner.sessionCookie,
			},
			body: JSON.stringify({ name: "Acme Two", slug: "acme-two" }),
		})
		expect(res.status).toBe(403)
		expect(res.status).not.toBe(401)
	})
})

// ----------------------------------------------------------------------------
// Fix #3 — 0002 migration survives a mid-apply crash on a fresh data dir
// ----------------------------------------------------------------------------

describe("0002_app_schema survives a mid-apply crash on a fresh data dir", () => {
	it("re-applying 0002 after a partial application completes without errors and the schema is intact", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-midcrash-"))
		const pgliteDir = join(dataDir, "pg")
		let pglite: PGlite | null = null
		try {
			pglite = await PGlite.create(pgliteDir)

			// Simulate a mid-apply crash: the first three CREATE TABLE
			// statements have run but the rest of the migration
			// (artifacts, screening_results, plan_limits, app_migrations
			// INSERT) never did. The next boot must finish the
			// migration cleanly.
			await pglite.exec(`
				CREATE TABLE app_migrations (
				  version TEXT PRIMARY KEY,
				  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
				);
				CREATE TABLE modules (
				  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				  scope VARCHAR(64) NOT NULL,
				  name VARCHAR(64) NOT NULL,
				  visibility VARCHAR(16) NOT NULL,
				  tier VARCHAR(32) NOT NULL,
				  description TEXT NOT NULL DEFAULT '',
				  created_by UUID,
				  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				  removed_at TIMESTAMPTZ,
				  CONSTRAINT modules_scope_name_uniq UNIQUE (scope, name),
				  CONSTRAINT modules_visibility_check CHECK (visibility IN ('public', 'org')),
				  CONSTRAINT modules_tier_check CHECK (
				    tier IN ('official', 'verified', 'community-screened', 'community-unverified')
				  )
				);
				CREATE TABLE module_versions (
				  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				  module_id UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
				  version VARCHAR(64) NOT NULL,
				  commit_sha VARCHAR(64) NOT NULL,
				  content_hash VARCHAR(64) NOT NULL,
				  manifest JSONB NOT NULL,
				  status VARCHAR(16) NOT NULL,
				  error TEXT,
				  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				  CONSTRAINT module_versions_module_id_version_uniq UNIQUE (module_id, version),
				  CONSTRAINT module_versions_status_check CHECK (
				    status IN ('pending', 'ingesting', 'ready', 'failed')
				  )
				);
				CREATE INDEX module_versions_content_hash_idx ON module_versions (content_hash);
			`)
			await pglite.close()
			pglite = null

			// Now re-run the full applyAppMigrations pipeline. The
			// already-created tables must be skipped (IF NOT EXISTS),
			// the missing tables must be created, the plan_limits seed
			// must apply, and the app_migrations INSERT must complete.
			await applyAppMigrations(await PGlite.create(pgliteDir))
			const recovered = await PGlite.create(pgliteDir)
			try {
				const tables = await recovered.query<{ table_name: string }>(
					`SELECT table_name FROM information_schema.tables
					   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
				)
				const names = tables.rows.map((r) => r.table_name)
				expect(names).toEqual(
					expect.arrayContaining([
						"modules",
						"module_versions",
						"artifacts",
						"screening_results",
						"plan_limits",
						"app_migrations",
					]),
				)

				// The app_migrations row was recorded on the recovery
				// pass — a second run is a no-op (the runner's
				// `applied.has(version)` guard short-circuits).
				const rows = await recovered.query<{ version: string }>(
					`SELECT version FROM app_migrations WHERE version = '0002_app_schema'`,
				)
				expect(rows.rows).toHaveLength(1)

				// The default plan seeds are present (the migration
				// must finish to the end, not stop at CREATE TABLE).
				const plans = await recovered.query<{ plan: string }>(`SELECT plan FROM plan_limits ORDER BY plan`)
				expect(plans.rows.map((r) => r.plan)).toEqual(["free", "pro"])
			} finally {
				await recovered.close()
			}
		} finally {
			if (pglite) await pglite.close().catch(() => {})
			rmSync(dataDir, { recursive: true, force: true })
		}
	})
})

// ----------------------------------------------------------------------------
// Fix #4 — API-key rate limit env vars parse correctly + default preserved
// ----------------------------------------------------------------------------

describe("API-key rate limit env parsing", () => {
	it("returns undefined when no rate-limit env vars are set (default unchanged)", () => {
		expect(parseApiKeyRateLimitEnv({})).toBeUndefined()
	})

	it("REGISTRY_API_KEY_RATE_LIMIT=off disables the check", () => {
		const parsed = parseApiKeyRateLimitEnv({ REGISTRY_API_KEY_RATE_LIMIT: "off" })
		expect(parsed?.enabled).toBe(false)
	})

	it("REGISTRY_API_KEY_RATE_LIMIT=false / 0 / disabled all disable the check", () => {
		expect(parseApiKeyRateLimitEnv({ REGISTRY_API_KEY_RATE_LIMIT: "false" })?.enabled).toBe(false)
		expect(parseApiKeyRateLimitEnv({ REGISTRY_API_KEY_RATE_LIMIT: "0" })?.enabled).toBe(false)
		expect(parseApiKeyRateLimitEnv({ REGISTRY_API_KEY_RATE_LIMIT: "disabled" })?.enabled).toBe(false)
	})

	it("REGISTRY_API_KEY_RATE_LIMIT_MAX raises the request ceiling", () => {
		const parsed = parseApiKeyRateLimitEnv({ REGISTRY_API_KEY_RATE_LIMIT_MAX: "500" })
		expect(parsed?.maxRequests).toBe(500)
	})

	it("REGISTRY_API_KEY_RATE_LIMIT_WINDOW_MS raises the window length", () => {
		const parsed = parseApiKeyRateLimitEnv({ REGISTRY_API_KEY_RATE_LIMIT_WINDOW_MS: "60000" })
		expect(parsed?.timeWindowMs).toBe(60_000)
	})

	it("malformed numeric values are silently ignored (default behavior preserved)", () => {
		// A typo like REGISTRY_API_KEY_RATE_LIMIT_MAX=abc must NOT
		// refuse to boot; the contract is "default unchanged when
		// unset". Treat malformed values as if they were unset.
		const parsed = parseApiKeyRateLimitEnv({
			REGISTRY_API_KEY_RATE_LIMIT_MAX: "abc",
			REGISTRY_API_KEY_RATE_LIMIT_WINDOW_MS: "not-a-number",
		})
		expect(parsed?.maxRequests).toBeUndefined()
		expect(parsed?.timeWindowMs).toBeUndefined()
	})

	it("negative / zero numeric values are silently ignored", () => {
		const parsed = parseApiKeyRateLimitEnv({
			REGISTRY_API_KEY_RATE_LIMIT_MAX: "-1",
			REGISTRY_API_KEY_RATE_LIMIT_WINDOW_MS: "0",
		})
		expect(parsed?.maxRequests).toBeUndefined()
		expect(parsed?.timeWindowMs).toBeUndefined()
	})

	it("combining all three vars produces the full override shape", () => {
		const parsed = parseApiKeyRateLimitEnv({
			REGISTRY_API_KEY_RATE_LIMIT: "off",
			REGISTRY_API_KEY_RATE_LIMIT_MAX: "100",
			REGISTRY_API_KEY_RATE_LIMIT_WINDOW_MS: "60000",
		})
		expect(parsed).toEqual({
			enabled: false,
			maxRequests: 100,
			timeWindowMs: 60_000,
		})
	})
})

// ----------------------------------------------------------------------------
// Fix #5 — DELETE /v1/orgs/:slug works without a body and without content-type
// ----------------------------------------------------------------------------

describe("DELETE /v1/orgs/:slug forwards JSON content-type even when the client sends no body", () => {
	let fx: Stack
	beforeEach(async () => {
		fx = await buildStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("returns 2xx (not 415) when the client sends no content-type and no body on an empty org", async () => {
		// Owner creates an empty org, then DELETEs it WITHOUT setting
		// content-type. Before the fix, the forwarded request carried
		// no content-type but DID carry a JSON body, and Better-Auth
		// rejected with 415. The fix: forwardToAuth sets content-type
		// whenever the route builds a JSON body server-side.
		const ownerSignUp = await signUp(fx, "owner@example.com", "password-12345")
		const ownerKey = await createApiKey(fx, ownerSignUp.sessionCookie, { name: "owner-key" })

		const created = await fx.app.request("/v1/orgs", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": ownerKey.key,
			},
			body: JSON.stringify({ name: "Acme", slug: "acme" }),
		})
		expect(created.status).toBe(200)

		// Note: NO `content-type` header, NO body. The client only
		// sends a method + URL + origin + credential.
		const del = await fx.app.request("/v1/orgs/acme", {
			method: "DELETE",
			headers: {
				origin: fx.baseUrl,
				"x-api-key": ownerKey.key,
			},
		})
		expect(del.status).not.toBe(415)
		// The org is empty so the deletion goes through (2xx).
		expect(del.status).toBeGreaterThanOrEqual(200)
		expect(del.status).toBeLessThan(300)
	})
})
