/**
 * Full-stack seed server for user-testing validation (publishing-ingest).
 *
 * Unlike seed-server.ts (registry-core, auth assertions only), this
 * harness boots the COMPLETE production stack so publish/ingest/
 * download/unpublish flows can be driven black-box over curl:
 *
 *   PGlite + app migrations + pglite-socket + Better-Auth
 *   (email/password enabled for automated seeding) + plan column +
 *   REGISTRY_SEED_PLANS passthrough + official-org bootstrap +
 *   built-in catalog seed + filesystem storage + polling worker.
 *
 * The server persists its data dir across restarts (kill -9 included)
 * so kill-resume assertions (VAL-PUB-028 / VAL-CROSS-027) can restart
 * against the same DATA_DIR. Nothing is auto-deleted.
 *
 * Usage:
 *   HTTP_PORT=4310 DATA_DIR=/tmp/baka-pubval-main \
 *     npx tsx apps/registry/test/seed-publishing-server.ts
 *
 * Env:
 *   HTTP_PORT            (required) HTTP listener port.
 *   DATA_DIR             (required) persistent data dir (pg/ + artifacts/).
 *   SEED_CREDS_FILE      creds JSON output (default /tmp/baka-pubval-creds-<port>.json).
 *   SEED                 "1" (default) seeds users/org/keys; "0" skips
 *                        (restart against an existing DATA_DIR).
 *   SEED_ORG             org slug to create (default "acme").
 *   SEED_WITH_ADMIN_MEMBER  "1" (default) invites+accepts admin+member
 *                        into the org; "0" leaves the org owner-only
 *                        (plan-limit member tests need headroom).
 *   REGISTRY_SEED_PLANS  passed through to applySeedPlans at every boot.
 *   REGISTRY_API_KEY_RATE_LIMIT  "off" recommended (seeded keys are
 *                        hammered during validation).
 *   WORKER_DISABLED      "1" boots without the polling worker (rows
 *                        stay pending) — used by kill-resume flows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { serve } from "@hono/node-server"
import { createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { ensureOfficialOrg } from "../src/auth/official-org"
import { applySeedPlans, ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { seedBuiltInCatalog } from "../src/catalog/seed"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"
import { createFilesystemStorage } from "../src/storage"
import { createInMemoryEnqueuer } from "../src/worker/enqueue"
import { startWorker } from "../src/worker/runner"

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`seed-publishing-server: ${name} is required`)
	return value
}

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 4310)
const DATA_DIR = requireEnv("DATA_DIR")
const CREDS_FILE = process.env.SEED_CREDS_FILE ?? `/tmp/baka-pubval-creds-${HTTP_PORT}.json`
const SEED = process.env.SEED !== "0"
const SEED_ORG = process.env.SEED_ORG ?? "acme"
const SEED_ORG_NAME = process.env.SEED_ORG_NAME ?? "Acme"
const SEED_WITH_ADMIN_MEMBER = process.env.SEED_WITH_ADMIN_MEMBER !== "0"
const OFFICIAL_ORG = "baka"

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

interface SeededUser {
	userId: string
	sessionCookie: string
	apiKey: string
	apiKeyId: string
}

function extractSessionCookie(setCookie: string): string {
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

async function main(): Promise<void> {
	const pgliteDir = join(DATA_DIR, "pg")
	const storageDir = join(DATA_DIR, "artifacts")
	mkdirSync(pgliteDir, { recursive: true })
	mkdirSync(storageDir, { recursive: true })

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
	const baseUrl = `http://127.0.0.1:${HTTP_PORT}`
	const betterAuth = await createBetterAuth(pool, {
		baseUrl,
		githubClientId: "test-github-client-id",
		githubClientSecret: "test-github-client-secret",
		secret: "test-secret-do-not-use-in-production",
		emailAndPassword: { enabled: true },
		apiKeyRateLimit: { enabled: false },
	})
	await betterAuth.ensureTables()
	await ensureOrgPlanColumn(pglite)
	await applySeedPlans(pglite, process.env.REGISTRY_SEED_PLANS)
	await seedBuiltInCatalog(pglite, OFFICIAL_ORG)

	const storage = createFilesystemStorage(storageDir)
	const enqueueIngest = createInMemoryEnqueuer()
	let worker: Awaited<ReturnType<typeof startWorker>> | null = null
	if (process.env.WORKER_DISABLED !== "1") {
		worker = await startWorker({ pglite, storage })
	}

	const app = buildApp({
		auth: betterAuth.auth,
		pglite,
		officialOrg: OFFICIAL_ORG,
		enqueueIngest: async (versionId) => {
			await enqueueIngest.enqueue(versionId)
		},
		storage,
	})

	const request = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
		app.request(path, {
			method: init.method ?? "GET",
			headers: { "content-type": "application/json", origin: baseUrl, ...init.headers },
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		})

	const signUp = async (email: string, password: string): Promise<{ userId: string; sessionCookie: string }> => {
		const res = await request("/api/auth/sign-up/email", {
			method: "POST",
			body: { email, password, name: email },
		})
		if (res.status !== 200) throw new Error(`sign-up ${email}: ${res.status} ${await res.text()}`)
		const body = (await res.json()) as { user: { id: string } }
		const sessionCookie = extractSessionCookie(res.headers.get("set-cookie") ?? "")
		if (!sessionCookie) throw new Error(`sign-up ${email}: no session cookie`)
		return { userId: body.user.id, sessionCookie }
	}

	const createKey = async (sessionCookie: string, name: string): Promise<{ id: string; key: string }> => {
		const res = await request("/api/auth/api-key/create", {
			method: "POST",
			headers: { cookie: sessionCookie },
			body: { name },
		})
		if (res.status !== 200) throw new Error(`api-key create: ${res.status} ${await res.text()}`)
		return (await res.json()) as { id: string; key: string }
	}

	if (SEED) {
		type Role = "owner" | "admin" | "member" | "outsider"
		const emails: Record<Role, string> = {
			owner: "owner@example.com",
			admin: "admin@example.com",
			member: "member@example.com",
			outsider: "outsider@example.com",
		}
		const seeded: Record<string, SeededUser> = {}
		for (const role of ["owner", "admin", "member", "outsider"] as const) {
			const { userId, sessionCookie } = await signUp(emails[role], "password-12345")
			const key = await createKey(sessionCookie, `${role}-key`)
			seeded[role] = { userId, sessionCookie, apiKey: key.key, apiKeyId: key.id }
		}

		const createRes = await request("/v1/orgs", {
			method: "POST",
			headers: { "x-api-key": seeded.owner.apiKey },
			body: { name: SEED_ORG_NAME, slug: SEED_ORG },
		})
		if (createRes.status !== 200) throw new Error(`org create: ${createRes.status} ${await createRes.text()}`)

		if (SEED_WITH_ADMIN_MEMBER) {
			for (const role of ["admin", "member"] as const) {
				const inviteRes = await request(`/v1/orgs/${SEED_ORG}/invite`, {
					method: "POST",
					headers: { "x-api-key": seeded.owner.apiKey },
					body: { email: emails[role], role },
				})
				if (inviteRes.status !== 200) throw new Error(`invite ${role}: ${inviteRes.status} ${await inviteRes.text()}`)
				const inviteBody = (await inviteRes.json()) as { id: string }
				const acceptRes = await request(`/v1/orgs/${SEED_ORG}/accept-invitation`, {
					method: "POST",
					headers: { "x-api-key": seeded[role].apiKey },
					body: { invitationId: inviteBody.id },
				})
				if (acceptRes.status !== 200) {
					throw new Error(`accept ${role}: ${acceptRes.status} ${await acceptRes.text()}`)
				}
			}
		}

		writeFileSync(
			CREDS_FILE,
			JSON.stringify(
				{
					httpPort: HTTP_PORT,
					baseUrl,
					dataDir: DATA_DIR,
					storageDir,
					org: { slug: SEED_ORG, name: SEED_ORG_NAME },
					keys: {
						owner: seeded.owner.apiKey,
						admin: seeded.admin.apiKey,
						member: seeded.member.apiKey,
						outsider: seeded.outsider.apiKey,
					},
					keyIds: {
						owner: seeded.owner.apiKeyId,
						admin: seeded.admin.apiKeyId,
						member: seeded.member.apiKeyId,
						outsider: seeded.outsider.apiKeyId,
					},
					cookies: {
						owner: seeded.owner.sessionCookie,
						admin: seeded.admin.sessionCookie,
						member: seeded.member.sessionCookie,
						outsider: seeded.outsider.sessionCookie,
					},
					userIds: {
						owner: seeded.owner.userId,
						admin: seeded.admin.userId,
						member: seeded.member.userId,
						outsider: seeded.outsider.userId,
					},
					emails,
				},
				null,
				2,
			),
		)
	}

	// Official-publisher grant (architecture §8 decision 29). The
	// production path reads REGISTRY_OFFICIAL_PUBLISHERS at boot via
	// config.ts; this harness grants the seeded owner's key through the
	// same ensureOfficialOrg entry point so VAL-PUB-010 can publish to
	// the official scope. Idempotent across restarts.
	let ownerKey: string | undefined
	if (SEED) {
		ownerKey = (JSON.parse(readFileSync(CREDS_FILE, "utf8")) as { keys: { owner: string } }).keys.owner
	} else if (existsSync(CREDS_FILE)) {
		ownerKey = (JSON.parse(readFileSync(CREDS_FILE, "utf8")) as { keys: { owner: string } }).keys.owner
	}
	const officialResult = await ensureOfficialOrg(pglite, {
		officialOrg: OFFICIAL_ORG,
		officialPublishers: ownerKey,
	})

	serve({ fetch: app.fetch, port: HTTP_PORT, hostname: "127.0.0.1" }, (info) => {
		process.stdout.write(
			`seed-publishing-server: listening on http://127.0.0.1:${info.port} ` +
				`(data=${DATA_DIR}, worker=${worker ? "enabled" : "disabled"}, seed=${SEED}, ` +
				`officialOrg=${OFFICIAL_ORG} created=${officialResult.created} granted=${officialResult.publishersGranted}, ` +
				`creds=${CREDS_FILE})\n`,
		)
	})

	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		process.stdout.write(`seed-publishing-server: received ${signal}, shutting down\n`)
		if (worker) await worker.stop().catch(() => {})
		await betterAuth.close().catch(() => {})
		await socket.stop().catch(() => {})
		await pglite.close().catch(() => {})
		process.exit(0)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err)
	process.stderr.write(`seed-publishing-server: failed to start — ${message}\n`)
	process.exit(1)
})
