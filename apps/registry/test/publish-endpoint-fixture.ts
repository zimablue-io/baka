import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import type { Hono } from "hono"
import { type BetterAuthHandle, createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { ensureOfficialOrg } from "../src/auth/official-org"
import { ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"
import { createFilesystemStorage, type StorageAdapter } from "../src/storage"

/**
 * Test fixture for the publish-endpoint feature (architecture §4.5,
 * VAL-PUB-002/010/011/020/021/024/032, VAL-AUTH-009, VAL-SELF-006).
 *
 * Boots a fresh PGlite + Better-Auth + Hono stack, seeds the
 * official org (via `ensureOfficialOrg`), creates the `acme` org,
 * signs up four identities (owner / admin / member / outsider),
 * and mints an API key per identity so role-enforcement assertions
 * can be exercised through the `x-api-key` header (the API-key
 * path bypasses origin check, which keeps the tests hermetic).
 */

export interface PublishTestStack {
	app: Hono
	betterAuth: BetterAuthHandle
	pglite: PGlite
	socket: PGLiteSocketServer
	storage: StorageAdapter
	storageDir: string
	baseUrl: string
	dataDir: string
	pgliteDir: string
	officialOrg: string
	keys: {
		owner: string
		admin: string
		member: string
		outsider: string
		officialPublisher: string
	}
	users: {
		owner: string
		admin: string
		member: string
		outsider: string
		officialPublisher: string
	}
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

export async function buildPublishTestStack(opts: { officialOrg?: string } = {}): Promise<PublishTestStack> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-publish-"))
	const pgliteDir = join(dataDir, "pg")
	const storageDir = join(dataDir, "artifacts")
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

	const storage = createFilesystemStorage(storageDir)
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

	const officialOrg = opts.officialOrg ?? "baka"
	await ensureOfficialOrg(pglite, betterAuth.auth, { officialOrg })

	const app = buildApp({ auth: betterAuth.auth, pglite, officialOrg, storage })

	// Sign up five users: four for the acme org plus one for the
	// official org (granted owner role via `ensureOfficialOrg`'s
	// API-key bootstrap path).
	const owner = await signUp(app, baseUrl, "owner@example.com", "password-12345")
	const admin = await signUp(app, baseUrl, "admin@example.com", "password-12345")
	const member = await signUp(app, baseUrl, "member@example.com", "password-12345")
	const outsider = await signUp(app, baseUrl, "outsider@example.com", "password-12345")
	const officialPublisher = await signUp(app, baseUrl, "official-publisher@example.com", "password-12345")

	const ownerKey = await createApiKey(app, baseUrl, owner.sessionCookie, "owner-key")
	const adminKey = await createApiKey(app, baseUrl, admin.sessionCookie, "admin-key")
	const memberKey = await createApiKey(app, baseUrl, member.sessionCookie, "member-key")
	const outsiderKey = await createApiKey(app, baseUrl, outsider.sessionCookie, "outsider-key")
	const officialPublisherKey = await createApiKey(
		app,
		baseUrl,
		officialPublisher.sessionCookie,
		"official-publisher-key",
	)

	// Re-run official-org bootstrap with the new API key so the
	// publisher is granted owner role on the official scope.
	await ensureOfficialOrg(pglite, betterAuth.auth, {
		officialOrg,
		officialPublishers: officialPublisherKey.key,
	})

	// Create acme org as owner.
	const acmeRes = await app.request("/v1/orgs", {
		method: "POST",
		headers: { "content-type": "application/json", origin: baseUrl, "x-api-key": ownerKey.key },
		body: JSON.stringify({ name: "Acme", slug: "acme" }),
	})
	if (acmeRes.status !== 200) {
		throw new Error(`acme create failed: ${acmeRes.status} ${await acmeRes.text()}`)
	}

	// Invite admin and member, accept as each.
	for (const role of ["admin", "member"] as const) {
		const inviteEmail = role === "admin" ? "admin@example.com" : "member@example.com"
		const inviteKey = role === "admin" ? adminKey.key : memberKey.key
		const inviteRes = await app.request(`/v1/orgs/acme/invite`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: baseUrl, "x-api-key": ownerKey.key },
			body: JSON.stringify({ email: inviteEmail, role }),
		})
		if (inviteRes.status !== 200) {
			throw new Error(`invite ${role} failed: ${inviteRes.status} ${await inviteRes.text()}`)
		}
		const inviteBody = (await inviteRes.json()) as { id: string }
		const acceptRes = await app.request(`/v1/orgs/acme/accept-invitation`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: baseUrl, "x-api-key": inviteKey },
			body: JSON.stringify({ invitationId: inviteBody.id }),
		})
		if (acceptRes.status !== 200) {
			throw new Error(`accept ${role} failed: ${acceptRes.status} ${await acceptRes.text()}`)
		}
	}

	return {
		app,
		betterAuth,
		pglite,
		socket,
		storage,
		storageDir,
		baseUrl,
		dataDir,
		pgliteDir,
		officialOrg,
		keys: {
			owner: ownerKey.key,
			admin: adminKey.key,
			member: memberKey.key,
			outsider: outsiderKey.key,
			officialPublisher: officialPublisherKey.key,
		},
		users: {
			owner: owner.userId,
			admin: admin.userId,
			member: member.userId,
			outsider: outsider.userId,
			officialPublisher: officialPublisher.userId,
		},
		close: async () => {
			await betterAuth.close().catch(() => {})
			await socket.stop().catch(() => {})
			await pglite.close().catch(() => {})
			rmSync(dataDir, { recursive: true, force: true })
		},
	}
}

async function signUp(
	app: Hono,
	baseUrl: string,
	email: string,
	password: string,
): Promise<{ userId: string; sessionCookie: string }> {
	const res = await app.request("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "content-type": "application/json", origin: baseUrl },
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

async function createApiKey(
	app: Hono,
	baseUrl: string,
	sessionCookie: string,
	name: string,
): Promise<{ id: string; key: string }> {
	const res = await app.request("/api/auth/api-key/create", {
		method: "POST",
		headers: { "content-type": "application/json", origin: baseUrl, cookie: sessionCookie },
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
