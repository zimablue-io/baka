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
import { createFilesystemStorage, type StorageAdapter } from "../src/storage"
import { startWorker, type WorkerHandle } from "../src/worker/runner"

/**
 * Test fixture for the ingest worker feature (architecture §4.5,
 * VAL-PUB-003 / 004 / 008 / 009 / 012 / 014 / 015 / 018 / 022 /
 * 023 / 026 / 027 / 028).
 *
 * Boots a real PGlite + Better-Auth + Hono stack, then starts a
 * graphile-worker runner against the same data via pglite-socket.
 * The publish endpoint is wired with a real enqueuer so a normal
 * `POST /v1/publish` produces a real `ingest_module_version` job
 * that the worker picks up on its next poll.
 *
 * Each test gets its own data dir, port, and fixture so workers
 * and storage are isolated. The fixture exposes `waitForTerminal`
 * for assertions that need to poll until a version reaches
 * `ready` / `failed` (the worker's pollInterval is 1000ms; the
 * helper polls the DB every 200ms with a 30s ceiling).
 */

export interface IngestTestStack {
	app: Hono
	betterAuth: BetterAuthHandle
	pglite: PGlite
	socket: PGLiteSocketServer
	storage: StorageAdapter
	worker: WorkerHandle
	baseUrl: string
	dataDir: string
	storageDir: string
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
	connectionString: string
	waitForTerminal: (
		versionId: string,
		opts?: { timeoutMs?: number },
	) => Promise<{
		status: "pending" | "ingesting" | "ready" | "failed"
		error: string | null
		contentHash: string | null
		commitSha: string | null
	}>
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

export async function buildIngestTestStack(opts: { officialOrg?: string } = {}): Promise<IngestTestStack> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-registry-ingest-"))
	const pgliteDir = join(dataDir, "pg")
	const storageDir = join(dataDir, "artifacts")
	const socketPort = await pickEphemeralPort()
	const baseUrl = `http://127.0.0.1:${socketPort + 1}`

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

	// Build the app FIRST so the publish endpoint can enqueue (it
	// records the enqueue against an in-memory list — the actual
	// row discovery is done by the polling worker below). The
	// storage adapter is wired in so the download endpoint can
	// serve the tarball after the worker promotes a version to
	// ready (VAL-PUB-007).
	const app = buildApp({
		auth: betterAuth.auth,
		pglite,
		officialOrg,
		storage,
	})

	// Seed users, orgs, and roles (mirrors publish-endpoint-fixture).
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

	// Owner creates acme; invite admin + member.
	const acmeRes = await app.request("/v1/orgs", {
		method: "POST",
		headers: { "content-type": "application/json", origin: baseUrl, "x-api-key": ownerKey.key },
		body: JSON.stringify({ name: "Acme", slug: "acme" }),
	})
	if (acmeRes.status !== 200) {
		throw new Error(`acme create failed: ${acmeRes.status} ${await acmeRes.text()}`)
	}

	for (const role of ["admin", "member"] as const) {
		const inviteEmail = role === "admin" ? "admin@example.com" : "member@example.com"
		const inviteKey = role === "admin" ? adminKey.key : memberKey.key
		const inviteRes = await app.request("/v1/orgs/acme/invite", {
			method: "POST",
			headers: { "content-type": "application/json", origin: baseUrl, "x-api-key": ownerKey.key },
			body: JSON.stringify({ email: inviteEmail, role }),
		})
		if (inviteRes.status !== 200) {
			throw new Error(`invite ${role} failed: ${inviteRes.status} ${await inviteRes.text()}`)
		}
		const inviteBody = (await inviteRes.json()) as { id: string }
		const acceptRes = await app.request("/v1/orgs/acme/accept-invitation", {
			method: "POST",
			headers: { "content-type": "application/json", origin: baseUrl, "x-api-key": inviteKey },
			body: JSON.stringify({ invitationId: inviteBody.id }),
		})
		if (acceptRes.status !== 200) {
			throw new Error(`accept ${role} failed: ${acceptRes.status} ${await acceptRes.text()}`)
		}
	}

	// Start the polling worker LAST so it observes rows that the
	// app creates via the publish endpoint. The worker reads
	// `module_versions.status='pending'` directly; no graphile-
	// worker coordination needed.
	const worker = await startWorker({
		pglite,
		storage,
		pollIntervalMs: 250,
	})

	const waitForTerminal = async (
		versionId: string,
		waitOpts: { timeoutMs?: number } = {},
	): Promise<{
		status: "pending" | "ingesting" | "ready" | "failed"
		error: string | null
		contentHash: string
		commitSha: string
	}> => {
		const timeoutMs = waitOpts.timeoutMs ?? 30_000
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const row = await pglite.query<{
				status: string
				error: string | null
				content_hash: string
				commit_sha: string
			}>(`SELECT status, error, content_hash, commit_sha FROM module_versions WHERE id = $1`, [versionId])
			const r = row.rows[0]
			if (r && (r.status === "ready" || r.status === "failed")) {
				return {
					status: r.status as "ready" | "failed",
					error: r.error,
					contentHash: r.content_hash,
					commitSha: r.commit_sha,
				}
			}
			await new Promise((r2) => setTimeout(r2, 200))
		}
		const finalRow = await pglite.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [
			versionId,
		])
		const status = (finalRow.rows[0]?.status ?? "pending") as "pending" | "ingesting" | "ready" | "failed"
		return { status, error: null, contentHash: "", commitSha: "" }
	}

	return {
		app,
		betterAuth,
		pglite,
		socket,
		storage,
		worker,
		baseUrl,
		dataDir,
		storageDir,
		pgliteDir,
		officialOrg,
		connectionString: `postgres://x:x@127.0.0.1:${socketPort}/postgres`,
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
		waitForTerminal,
		close: async () => {
			await worker.stop().catch(() => {})
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
