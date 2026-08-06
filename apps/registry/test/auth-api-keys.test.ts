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
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"

/**
 * API-key feature tests (architecture §4.4, validation contract
 * VAL-AUTH-004 / 012 / 013 / 014).
 *
 * The `@better-auth/api-key` plugin provides the create / list / get /
 * delete endpoints and the `x-api-key` middleware that turns an API
 * key header into a session. These tests exercise that surface end to
 * end against a real PGlite + Better-Auth stack.
 *
 * The fixtures enable email/password sign-up (test-only) so we can
 * seed users without a real GitHub OAuth dance. Production builds do
 * NOT enable email/password — GitHub OAuth is the only public auth
 * path.
 */

interface ApiKeyFixture {
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

async function buildApiKeyFixture(): Promise<ApiKeyFixture> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-apikeys-"))
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

	const app = buildApp({ auth: betterAuth.auth, pglite })

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

/**
 * The login shape: a session cookie attached to subsequent requests.
 * Better-Auth returns the session token in the body AND sets a cookie;
 * we capture the cookie to mirror what a browser would do.
 */
async function signUp(
	fx: ApiKeyFixture,
	email: string,
	password: string,
): Promise<{ userId: string; sessionCookie: string }> {
	const res = await fx.app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", origin: fx.baseUrl },
		body: JSON.stringify({ email, password, name: email }),
	})
	if (res.status !== 200) {
		const body = await res.text()
		throw new Error(`sign-up failed: ${res.status} ${body}`)
	}
	const body = (await res.json()) as { user: { id: string } }
	const setCookie = res.headers.get("set-cookie") ?? ""
	const sessionCookie = extractBetterAuthCookie(setCookie)
	if (!sessionCookie) {
		throw new Error("sign-up did not return a session cookie")
	}
	return { userId: body.user.id, sessionCookie }
}

function extractBetterAuthCookie(setCookie: string): string {
	// The session cookie is `better-auth.session_token=<value>` (or
	// __Secure- prefixed). Capture all relevant cookie pairs so the
	// header is a complete cookie: value for downstream requests.
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
	fx: ApiKeyFixture,
	sessionCookie: string,
	opts: { name?: string; expiresIn?: number } = {},
): Promise<{ id: string; key: string }> {
	const res = await fx.app.request("/api/auth/api-key/create", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: fx.baseUrl,
			cookie: sessionCookie,
		},
		body: JSON.stringify({ name: opts.name ?? "test-key", expiresIn: opts.expiresIn ?? null }),
	})
	if (res.status !== 200) {
		const body = await res.text()
		throw new Error(`create-api-key failed: ${res.status} ${body}`)
	}
	const body = (await res.json()) as { id: string; key: string }
	return { id: body.id, key: body.key }
}

/**
 * Force a key into the expired state by directly updating its row.
 * We can't trivially wait for real time in a test; the apiKey plugin
 * reads `expiresAt` from the DB row on every request, so a one-row
 * UPDATE faithfully simulates the post-expiry state.
 */
async function forceExpireKey(fx: ApiKeyFixture, keyId: string): Promise<void> {
	await fx.pglite.query(`UPDATE apikey SET "expiresAt" = NOW() - INTERVAL '1 minute' WHERE id = $1`, [keyId])
}

/**
 * Capture every byte the process writes to stdout/stderr between
 * start() and restore(). Lets the credential-isolation test grep the
 * captured buffer for issued key values.
 */
function captureStdoutStderr(): { read: () => string; restore: () => void } {
	const originalOut = process.stdout.write.bind(process.stdout)
	const originalErr = process.stderr.write.bind(process.stderr)
	const buffer: string[] = []
	const tap = (orig: typeof process.stdout.write): typeof process.stdout.write =>
		((chunk: string | Uint8Array, ...rest: unknown[]) => {
			buffer.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
			return (orig as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...(rest as []))
		}) as typeof process.stdout.write
	process.stdout.write = tap(originalOut)
	process.stderr.write = tap(originalErr)
	return {
		read: () => buffer.join(""),
		restore: () => {
			process.stdout.write = originalOut
			process.stderr.write = originalErr
		},
	}
}

// ----------------------------------------------------------------------------
// VAL-AUTH-004 — API key creation, use, revocation
// ----------------------------------------------------------------------------

describe("VAL-AUTH-004 — API key creation, use, revocation", () => {
	let fx: ApiKeyFixture
	beforeEach(async () => {
		fx = await buildApiKeyFixture()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("creates an API key with a session cookie; get-session resolves to the same identity via x-api-key", async () => {
		const { userId, sessionCookie } = await signUp(fx, "owner@example.com", "password-12345")
		const { key } = await createApiKey(fx, sessionCookie, { name: "primary" })

		expect(typeof key).toBe("string")
		// Better-Auth issues keys with a recognizable prefix
		expect(key.length).toBeGreaterThan(20)

		// Cookie session resolves to the same identity
		const cookieRes = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { cookie: sessionCookie, origin: fx.baseUrl },
		})
		expect(cookieRes.status).toBe(200)
		const cookieBody = (await cookieRes.json()) as { user?: { id?: string } } | null
		expect(cookieBody?.user?.id).toBe(userId)

		// API key resolves to the same identity via x-api-key
		const apiKeyRes = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": key, origin: fx.baseUrl },
		})
		expect(apiKeyRes.status).toBe(200)
		const apiKeyBody = (await apiKeyRes.json()) as { user?: { id?: string } } | null
		expect(apiKeyBody?.user?.id).toBe(userId)
	})

	it("revoking a key by id makes the same x-api-key request return 401; a second unrevoked key still works", async () => {
		const { sessionCookie } = await signUp(fx, "revoker@example.com", "password-12345")
		const a = await createApiKey(fx, sessionCookie, { name: "a" })
		const b = await createApiKey(fx, sessionCookie, { name: "b" })

		// Both keys work before revocation
		const beforeA = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": a.key, origin: fx.baseUrl },
		})
		expect(beforeA.status).toBe(200)

		// Revoke key a
		const del = await fx.app.request("/api/auth/api-key/delete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				cookie: sessionCookie,
			},
			body: JSON.stringify({ keyId: a.id }),
		})
		expect(del.status).toBe(200)

		// Revoked key now rejected
		const afterA = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": a.key, origin: fx.baseUrl },
		})
		expect(afterA.status).toBe(401)

		// Sibling key still works
		const afterB = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": b.key, origin: fx.baseUrl },
		})
		expect(afterB.status).toBe(200)
	})
})

// ----------------------------------------------------------------------------
// VAL-AUTH-012 — Expired API key is rejected (401, never a resolved identity)
// ----------------------------------------------------------------------------

describe("VAL-AUTH-012 — expired API key is rejected with 401", () => {
	let fx: ApiKeyFixture
	beforeEach(async () => {
		fx = await buildApiKeyFixture()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("a key whose expiresAt has passed returns 401; a non-expired sibling keeps resolving", async () => {
		const { sessionCookie } = await signUp(fx, "expire@example.com", "password-12345")
		const expired = await createApiKey(fx, sessionCookie, { name: "expired" })
		const alive = await createApiKey(fx, sessionCookie, { name: "alive" })

		// Both work before the forced expiry
		const beforeExpired = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": expired.key, origin: fx.baseUrl },
		})
		expect(beforeExpired.status).toBe(200)

		// Force the key into the expired state. We bypass the plugin's
		// minimum expiry (1 day) by writing the DB column directly; the
		// plugin reads expires_at on every request, so the next call
		// sees the post-expiry row.
		await forceExpireKey(fx, expired.id)

		// Expired key now rejected with 401 (translated from the plugin's
		// 403 — see auth/handlers.ts).
		const afterExpired = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": expired.key, origin: fx.baseUrl },
		})
		expect(afterExpired.status).toBe(401)
		const body = (await afterExpired.json()) as { error?: string; message?: string }
		// The body shape varies by plugin version; either Better-Auth's
		// `{message}` or the registry's translated `{error}` is honest.
		const errorField = typeof body.error === "string" ? body.error : body.message
		expect(typeof errorField).toBe("string")

		// Sibling key still resolves
		const afterAlive = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": alive.key, origin: fx.baseUrl },
		})
		expect(afterAlive.status).toBe(200)
	})
})

// ----------------------------------------------------------------------------
// VAL-AUTH-013 — Malformed or unknown API key returns 401, not 500
// ----------------------------------------------------------------------------

describe("VAL-AUTH-013 — malformed or unknown API keys return 401", () => {
	let fx: ApiKeyFixture
	beforeEach(async () => {
		fx = await buildApiKeyFixture()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("returns 401 for a completely malformed key value", async () => {
		const res = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": "not-a-real-key", origin: fx.baseUrl },
		})
		expect(res.status).toBe(401)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
		const body = (await res.json()) as { error?: string }
		expect(typeof body.error).toBe("string")
	})

	it("returns 401 for a syntactically well-formed but never-issued key", async () => {
		const res = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: {
				"x-api-key": "baka_this_looks_real_but_was_never_issued_by_this_server_abcdefghij1234567890",
				origin: fx.baseUrl,
			},
		})
		expect(res.status).toBe(401)
	})

	it("the server stays up and serves a subsequent well-formed authenticated request after a bad key", async () => {
		const bad = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { "x-api-key": "garbage", origin: fx.baseUrl },
		})
		expect(bad.status).toBe(401)

		const { sessionCookie } = await signUp(fx, "healthy@example.com", "password-12345")
		const good = await fx.app.request("/api/auth/get-session", {
			method: "GET",
			headers: { cookie: sessionCookie, origin: fx.baseUrl },
		})
		expect(good.status).toBe(200)
	})
})

// ----------------------------------------------------------------------------
// VAL-AUTH-014 — Credential isolation (no API key or OAuth token in responses/logs)
// ----------------------------------------------------------------------------

describe("VAL-AUTH-014 — credential isolation", () => {
	let fx: ApiKeyFixture
	beforeEach(async () => {
		fx = await buildApiKeyFixture()
	})
	afterEach(async () => {
		await fx.close()
	})

	/**
	 * Walks every user-facing response the registry emits across the
	 * API-key flow and asserts no body contains a full API key value
	 * (the create endpoint is the only legitimate place the full key
	 * appears — every other surface must mask it).
	 */
	it("list and get responses never contain a full API key value", async () => {
		const { sessionCookie } = await signUp(fx, "isolation@example.com", "password-12345")
		const a = await createApiKey(fx, sessionCookie, { name: "isolation-a" })
		const b = await createApiKey(fx, sessionCookie, { name: "isolation-b" })
		const issuedKeys = new Set([a.key, b.key])

		// 1) /api/auth/api-key/list returns masked metadata only.
		const listRes = await fx.app.request("/api/auth/api-key/list", {
			method: "GET",
			headers: { cookie: sessionCookie, origin: fx.baseUrl },
		})
		expect(listRes.status).toBe(200)
		const listJson = JSON.stringify(await listRes.json())
		for (const key of issuedKeys) {
			expect(listJson).not.toContain(key)
		}

		// 2) /api/auth/api-key/get for each id returns masked metadata only.
		for (const { id } of [a, b]) {
			const getRes = await fx.app.request(`/api/auth/api-key/get?id=${encodeURIComponent(id)}`, {
				method: "GET",
				headers: { cookie: sessionCookie, origin: fx.baseUrl },
			})
			expect(getRes.status).toBe(200)
			const getJson = JSON.stringify(await getRes.json())
			for (const key of issuedKeys) {
				expect(getJson).not.toContain(key)
			}
		}

		// 3) /api/auth/get-session with the api key never echoes the key.
		for (const key of issuedKeys) {
			const sess = await fx.app.request("/api/auth/get-session", {
				method: "GET",
				headers: { "x-api-key": key, origin: fx.baseUrl },
			})
			const sessJson = JSON.stringify(await sess.json())
			for (const other of issuedKeys) {
				expect(sessJson).not.toContain(other)
			}
		}
	})

	/**
	 * Captures stdout + stderr across a representative subset of the
	 * API-key surface and asserts the captured log buffer contains no
	 * issued key values. We disable Better-Auth's internal logger so
	 * no framework log line can leak the credential.
	 */
	it("server log output during the API-key flow contains no issued key value", async () => {
		const cap = captureStdoutStderr()
		try {
			const { sessionCookie } = await signUp(fx, "logs@example.com", "password-12345")
			const key = await createApiKey(fx, sessionCookie, { name: "log-key" })

			// Hit a representative spread of endpoints with the key.
			await fx.app.request("/api/auth/get-session", {
				method: "GET",
				headers: { "x-api-key": key.key, origin: fx.baseUrl },
			})
			await fx.app.request("/api/auth/api-key/list", {
				method: "GET",
				headers: { cookie: sessionCookie, origin: fx.baseUrl },
			})
			await fx.app.request(`/api/auth/api-key/get?id=${encodeURIComponent(key.id)}`, {
				method: "GET",
				headers: { cookie: sessionCookie, origin: fx.baseUrl },
			})

			const captured = cap.read()
			expect(captured).not.toContain(key.key)
		} finally {
			cap.restore()
		}
	})
})
