import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import type { Hono } from "hono"
import { type BetterAuthHandle, createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"

/**
 * Test fixture for the orgs feature (architecture §4.4, validation
 * contract VAL-AUTH-005..008).
 *
 * Boots a fresh PGlite + Better-Auth + Hono stack with email/password
 * sign-up enabled so test users can be seeded without completing the
 * GitHub OAuth dance. The fixture re-uses the same
 * `createDatabase` / `buildApp` path the production binary uses; the
 * only short-circuit is binding to an ephemeral port so the test never
 * races the manifest's 4300 / 5444.
 */

export interface OrgTestStack {
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

export async function buildOrgTestStack(): Promise<OrgTestStack> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-orgs-"))
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
	// at first boot. Apply it now that the table exists (matches the
	// production server.ts boot order). Idempotent on subsequent boots.
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

/**
 * Sign up a user via email/password and return the session cookie.
 * Mirrors the api-key fixture's helper so the orgs tests can reuse
 * the same cookie pattern.
 */
export async function signUp(
	fx: OrgTestStack,
	email: string,
	password: string,
	name?: string,
): Promise<{ userId: string; sessionCookie: string }> {
	const res = await fx.app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", origin: fx.baseUrl },
		body: JSON.stringify({ email, password, name: name ?? email }),
	})
	if (res.status !== 200) {
		const body = await res.text()
		throw new Error(`sign-up failed for ${email}: ${res.status} ${body}`)
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

/**
 * Create an API key for the session. The org tests use API keys for
 * the role-enforcement assertions because the contract says the API
 * key path bypasses the origin check (architecture §4.4). Each user
 * gets a key they can present in `x-api-key`.
 */
export async function createApiKey(
	fx: OrgTestStack,
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
		const body = await res.text()
		throw new Error(`create-api-key failed: ${res.status} ${body}`)
	}
	const body = (await res.json()) as { id: string; key: string }
	return { id: body.id, key: body.key }
}

/**
 * Optional helper that issues a fetch with the right headers (origin
 * always set so mutating cookie requests don't get blocked by the
 * origin middleware).
 */
export function authedFetch(
	fx: OrgTestStack,
	path: string,
	init: { method?: string; body?: unknown; cookie?: string; apiKey?: string } = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		origin: fx.baseUrl,
	}
	if (init.cookie) headers.cookie = init.cookie
	if (init.apiKey) headers["x-api-key"] = init.apiKey
	return Promise.resolve(
		fx.app.request(path, {
			method: init.method ?? "GET",
			headers,
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		}),
	)
}
