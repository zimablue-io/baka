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
 * The harness ALSO publishes a community-screened fixture through the
 * REAL `POST /v1/publish` path (see `seedCommunityScreenedFixture`),
 * so a vanilla boot produces:
 *
 *   - empty production built-in catalog (tests may insert a `hello`
 *     fixture via seedCatalogPacks; built-in packs bypass screening
 *     and serve screening=null)
 *   - one public community pack on a non-bundled scope that
 *     passed through the real publish → ingest → screening pipeline
 *     with both preview states (rendered + needs-llm-with-sentinel)
 *     AND a real downloadable tarball
 *
 * The fixture is idempotent: a restart boot skips re-publishing
 * because the version row already exists. Validators and local
 * dev hit a fully-loaded registry from the moment the server is up.
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
 *   REGISTRY_VERIFIED_PACKS  passed through to applyVerifiedPacks at
 *                        every boot (SEED=0 restarts included), mirroring
 *                        the production boot path in src/server.ts — a
 *                        validator publishes first, then restarts with the
 *                        env set and observes the verified-tier pin
 *                        (VAL-SCAN-010).
 *   REGISTRY_API_KEY_RATE_LIMIT  "off" recommended (seeded keys are
 *                        hammered during validation).
 *   SCREEN_DRYRUN_TIMEOUT_MS  forwarded to the worker's per-recipe dry-run
 *                        timeout (architecture §8 decision 6, VAL-SCAN-013).
 *                        Unset keeps the 60s default.
 *   WORKER_DISABLED      "1" boots without the polling worker (rows
 *                        stay pending) — used by kill-resume flows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { serve } from "@hono/node-server"
import type { Hono } from "hono"
import { type BetterAuthHandle, createBetterAuth } from "../src/auth/better-auth"
import { createPgPool } from "../src/auth/kysely-db"
import { ensureOfficialOrg } from "../src/auth/official-org"
import { applySeedPlans, ensureOrgPlanColumn } from "../src/auth/plan-limits"
import { seedBuiltInCatalog, seedCatalogPacks } from "../src/catalog/seed"
import { applyAppMigrations } from "../src/db/migrate"
import { buildApp } from "../src/index"
import { applyVerifiedPacks } from "../src/screening/tier-assignment"
import { createFilesystemStorage, type StorageAdapter } from "../src/storage"
import { createInMemoryEnqueuer } from "../src/worker/enqueue"
import { startWorker, type WorkerHandle } from "../src/worker/runner"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { TEST_CATALOG_PACK } from "./test-catalog-pack"

interface SeededUser {
	userId: string
	sessionCookie: string
	apiKey: string
	apiKeyId: string
}

/**
 * The state `bootSeedPublishingServer` returns. Carries every handle
 * the seed step (and downstream callers) need:
 *   - `app` / `pglite` / `storage` for any subsequent API call
 *   - `ownerKey` + `orgSlug` so the seed step can authenticate
 *     against the just-created org
 *   - `worker` so a polling worker can be torn down on shutdown
 *   - `shutdown` to release the in-process resources cleanly
 *
 * The `git` field is supplied by the caller (the seed step needs
 * a tmp bare repo). The harness owns the rest of the resource
 * graph; `bootSeedPublishingServer` does not create the git
 * fixture so the caller controls its lifecycle.
 */
interface SeedPublishingHarness {
	app: Hono
	pglite: PGlite
	socket: PGLiteSocketServer
	betterAuth: BetterAuthHandle
	storage: StorageAdapter
	storageDir: string
	baseUrl: string
	dataDir: string
	pgliteDir: string
	socketPort: number
	officialOrg: string
	ownerKey: string
	orgSlug: string
	credsFile: string
	worker: WorkerHandle | null
	screenDryRunTimeoutMs: number | undefined
	shutdown: () => Promise<void>
}

/**
 * The outcome of `seedCommunityScreenedFixture`. The `skipped` flag
 * distinguishes "no-op because the version was already on disk"
 * (a restart boot) from "publish + wait succeeded in this call"
 * (a fresh boot).
 */
export interface CommunityFixtureResult {
	scope: string
	name: string
	version: string
	versionId: string
	status: "ready" | "failed"
	tier: string | null
	skipped: boolean
}

/**
 * Boots the seed-publishing-server's stack without starting the
 * HTTP listener. The boot is the production wiring minus the
 * `serve()` call: PGlite + app migrations + pglite-socket +
 * Better-Auth (email/password enabled) + plan column +
 * REGISTRY_SEED_PLANS passthrough + official-org bootstrap +
 * built-in catalog seed + filesystem storage + polling worker +
 * creds file.
 *
 * Tests / scripts that want the HTTP listener should call
 * `bootSeedPublishingServer` then `serve({ fetch: harness.app.fetch, ... })`
 * themselves; this split lets `seed-community-fixture.test.ts`
 * exercise the seed step through `app.request` without binding a port.
 */
async function bootSeedPublishingServer(opts: {
	dataDir: string
	httpPort: number
	officialOrg?: string
	credsFile?: string
	seed?: boolean
	seedOrg?: string
	seedOrgName?: string
	seedWithAdminMember?: boolean
	screenDryRunTimeoutMs?: number
	workerDisabled?: boolean
}): Promise<SeedPublishingHarness> {
	const dataDir = opts.dataDir
	const pgliteDir = join(dataDir, "pg")
	const storageDir = join(dataDir, "artifacts")
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
	const baseUrl = `http://127.0.0.1:${opts.httpPort}`
	const betterAuth = await createBetterAuth(pool, {
		baseUrl,
		githubClientId: "test-github-client-id",
		githubClientSecret: "test-github-client-secret",
		secret: "test-secret-do-not-use-in-production",
		emailAndPassword: { enabled: true },
		apiKeyRateLimit: { enabled: false },
		// Plan-limit enforcement hooks (VAL-SELF-006 step 3) wired
		// through `organizationHooks.beforeCreateInvitation` and
		// `...beforeAcceptInvitation`. The hooks share the in-process
		// PGlite handle that the worker uses; a TCP round-trip through
		// pglite-socket could deadlock against the worker's own
		// FOR UPDATE SKIP LOCKED claim, so we hand the hooks the
		// direct handle. Without this, the smoke server has no
		// member-limit gate and user-testing validators would
		// observe the bug.
		pglite,
	})
	await betterAuth.ensureTables()
	await ensureOrgPlanColumn(pglite)
	await applySeedPlans(pglite, process.env.REGISTRY_SEED_PLANS)
	const officialOrg = opts.officialOrg ?? "baka"
	await seedBuiltInCatalog(pglite, officialOrg)
	await seedCatalogPacks(pglite, officialOrg, [TEST_CATALOG_PACK])
	// Mirrors src/server.ts: the verified-tier seeder runs at every
	// boot, after the built-in catalog seed, and never refuses to
	// boot on a malformed entry.
	const verifiedResult = await applyVerifiedPacks(pglite, process.env.REGISTRY_VERIFIED_PACKS)
	if (verifiedResult.applied > 0) {
		process.stdout.write(`seed-publishing-server: pinned ${verifiedResult.applied} pack(s) to the verified tier\n`)
	}
	for (const failure of verifiedResult.failures) {
		process.stdout.write(`seed-publishing-server: WARNING REGISTRY_VERIFIED_PACKS entry invalid: ${failure.error}\n`)
	}

	const storage = createFilesystemStorage(storageDir)
	const enqueueIngest = createInMemoryEnqueuer()
	const screenDryRunTimeoutMs = opts.screenDryRunTimeoutMs
	let worker: WorkerHandle | null = null
	if (opts.workerDisabled !== true) {
		worker = await startWorker({ pglite, storage, screenDryRunTimeoutMs })
	}

	const app = buildApp({
		auth: betterAuth.auth,
		pglite,
		officialOrg,
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

	const seedEnabled = opts.seed !== false
	const seedOrg = opts.seedOrg ?? "acme"
	const seedOrgName = opts.seedOrgName ?? "Acme"
	const seedWithAdminMember = opts.seedWithAdminMember !== false
	const credsFile = opts.credsFile ?? `/tmp/baka-pubval-creds-${opts.httpPort}.json`

	if (seedEnabled) {
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
			body: { name: seedOrgName, slug: seedOrg },
		})
		if (createRes.status !== 200) throw new Error(`org create: ${createRes.status} ${await createRes.text()}`)

		if (seedWithAdminMember) {
			for (const role of ["admin", "member"] as const) {
				const inviteRes = await request(`/v1/orgs/${seedOrg}/invite`, {
					method: "POST",
					headers: { "x-api-key": seeded.owner.apiKey },
					body: { email: emails[role], role },
				})
				if (inviteRes.status !== 200) throw new Error(`invite ${role}: ${inviteRes.status} ${await inviteRes.text()}`)
				const inviteBody = (await inviteRes.json()) as { id: string }
				const acceptRes = await request(`/v1/orgs/${seedOrg}/accept-invitation`, {
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
			credsFile,
			JSON.stringify(
				{
					httpPort: opts.httpPort,
					baseUrl,
					dataDir,
					storageDir,
					org: { slug: seedOrg, name: seedOrgName },
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
	if (seedEnabled) {
		ownerKey = (JSON.parse(readFileSync(credsFile, "utf8")) as { keys: { owner: string } }).keys.owner
	} else if (existsSync(credsFile)) {
		ownerKey = (JSON.parse(readFileSync(credsFile, "utf8")) as { keys: { owner: string } }).keys.owner
	}
	const officialResult = await ensureOfficialOrg(pglite, {
		officialOrg,
		officialPublishers: ownerKey,
	})

	const shutdown = async (): Promise<void> => {
		if (worker) await worker.stop().catch(() => {})
		await betterAuth.close().catch(() => {})
		await socket.stop().catch(() => {})
		await pglite.close().catch(() => {})
	}

	return {
		app,
		pglite,
		socket,
		betterAuth,
		storage,
		storageDir,
		baseUrl,
		dataDir,
		pgliteDir,
		socketPort,
		officialOrg,
		ownerKey: ownerKey ?? "",
		orgSlug: seedOrg,
		credsFile,
		worker,
		screenDryRunTimeoutMs,
		shutdown,
		_officialResult: officialResult,
	} as SeedPublishingHarness & { _officialResult?: { created: boolean; publishersGranted: number } }
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

/**
 * The fixture pack the seed publishes through the real pipeline.
 *
 * The pack exercises BOTH preview states:
 *   - `greet` (non-reasoning) → sandboxed dry-run writes
 *     `greeting.txt` and the registry records a `rendered` preview.
 *   - `plan-feature` (`requiresReasoning: true`) → the registry's
 *     sentinel render path picks up the `{{!-- no-llm --}}` Handlebars
 *     template and surfaces the rendered bytes alongside the
 *     `needs-llm` state.
 *
 * The recipe bodies are deliberately minimal so the static capability
 * scan (layer 1) passes without surprises: `greet` imports
 * `node:fs` (allowlisted) and writes a single file inside its declared
 * `filePatterns`; `plan-feature` exports an empty default so no
 * runtime code reaches the scanner. The template uses no Handlebars
 * helpers (allowlist: `if`, `each`, `with`, `unless`, `else`), so the
 * scanner's Handlebars branch is also clean.
 *
 * Published at `v1.0.0` against the `acme` scope (the org the harness
 * creates by default). Visibility: `public` so the screening pipeline
 * runs end-to-end and the catalog surfaces the `community-screened`
 * tier badge on every read surface.
 */
const FIXTURE_PACK_NAME = "screened-fixture"
const FIXTURE_PACK_TAG = "v1.0.0"
const FIXTURE_PACK_VERSION = "1.0.0"

const FIXTURE_NON_REASONING_RECIPE_SOURCE = `import { writeFileSync } from "node:fs"
export default {
  name: "greet",
  role: 1,
  async execute() {
    writeFileSync("greeting.txt", "Hello from the baka community fixture!\\n")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {
    // no-op
  },
}
`

const FIXTURE_REASONING_RECIPE_SOURCE = `export default {
  name: "plan-feature",
  role: 1,
  async execute() {
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {
    // no-op
  },
}
`

const FIXTURE_SENTINEL_TEMPLATE = `{{!-- no-llm --}}# Welcome

This is a static welcome template from the baka community fixture.
It is shipped with the \`{{!-- no-llm --}}\` sentinel so the registry
renders it without invoking an LLM at apply time.

Reasoning recipes still require an LLM at apply time; this preview
shows the deterministic template render the LLM would otherwise
fill in.
`

/**
 * Publishes the community-screened fixture through the REAL
 * `POST /v1/publish` path (not the built-in catalog seed) and
 * waits for the polling worker to bring the version to a terminal
 * state.
 *
 * Idempotent across restarts: when the fixture's `(scope, name,
 * version)` row already exists on disk, the function returns the
 * existing record with `skipped: true`. A fresh DATA_DIR falls
 * through to the publish path. The check runs before any clone /
 * tarball work so a restart boot (SEED=0, validator round 2)
 * does not re-publish a row that is already on disk.
 *
 * The function also reads the version's terminal tier from the DB
 * so the caller can assert `community-screened` without an extra
 * catalog-list round trip.
 *
 * Errors:
 *   - Throws if the publish endpoint returns a non-2xx response
 *     (the fixture's manifest / filePatterns are pinned, so a
 *     rejection is a real bug — not a transient race).
 *   - Returns `{ status: "failed" }` (does NOT throw) if the
 *     worker terminates the row `failed` after the publish
 *     succeeds; the caller decides whether to retry or surface
 *     the verdict. The contract is "boot produces a load-bearing
 *     fixture or surfaces the failure honestly", not "boot must
 *     succeed at any cost".
 */
export async function seedCommunityScreenedFixture(opts: {
	app: Hono
	pglite: PGlite
	ownerKey: string
	orgSlug: string
	git: GitFixture
	timeoutMs?: number
}): Promise<CommunityFixtureResult> {
	const { app, pglite, ownerKey, orgSlug, git } = opts
	const timeoutMs = opts.timeoutMs ?? 60_000

	// Idempotency probe: if the fixture's version row already
	// exists on disk, return its terminal state. The check runs
	// BEFORE the git fixture is materialized so a restart boot
	// doesn't even allocate a tmp dir.
	const existing = await pglite.query<{
		id: string
		status: string
		tier: string
		commit_sha: string
		content_hash: string
	}>(
		`SELECT mv.id, mv.status, m.tier, mv.commit_sha, mv.content_hash
		   FROM pack_versions mv
		   JOIN packs m ON m.id = mv.pack_id
		  WHERE m.scope = $1
		    AND m.name = $2
		    AND mv.version = $3
		    AND m.removed_at IS NULL`,
		[orgSlug, FIXTURE_PACK_NAME, FIXTURE_PACK_TAG],
	)
	const prior = existing.rows[0]
	if (prior) {
		// The row may be pending / ingesting on a kill-resume
		// boot; the contract is "ready / failed only" on the
		// returned shape (the caller can poll again). Anything
		// non-terminal surfaces as `failed` so the boot log line
		// honestly reflects "the row is not yet served".
		const terminalStatus: "ready" | "failed" = prior.status === "ready" ? "ready" : "failed"
		return {
			scope: orgSlug,
			name: FIXTURE_PACK_NAME,
			version: FIXTURE_PACK_TAG,
			versionId: prior.id,
			status: terminalStatus,
			tier: prior.tier,
			skipped: true,
		}
	}

	// Materialize the fixture's bare git repo (the working tree
	// + commit + tag the publish endpoint will clone at).
	await git.commitManifest({
		name: `@${orgSlug}/${FIXTURE_PACK_NAME}`,
		version: FIXTURE_PACK_VERSION,
		tag: FIXTURE_PACK_TAG,
		packPath: "",
		description: "Community-screened fixture for landing-detail preview states (client-integration).",
		recipes: [
			{
				id: "greet",
				description: "Write a greeting file (non-reasoning, rendered preview).",
				filePatterns: ["greeting.txt"],
				requiresReasoning: false,
				body: FIXTURE_NON_REASONING_RECIPE_SOURCE,
			},
			{
				id: "plan-feature",
				description: "Plan a new feature (requires LLM, sentinel-rendered preview).",
				filePatterns: [],
				requiresReasoning: true,
				body: FIXTURE_REASONING_RECIPE_SOURCE,
			},
		],
		extras: [{ path: "plan-feature/templates/welcome.hbs", content: FIXTURE_SENTINEL_TEMPLATE }],
	})

	// Real publish through the public endpoint. The harness's app
	// is wired with the same publish→ingest→screening path the CLI
	// and MCP exercise, so a vanilla boot is indistinguishable
	// from a CLI-driven `baka publish` against this fixture.
	const res = await app.request("/v1/publish", {
		method: "POST",
		headers: { "x-api-key": ownerKey },
		body: JSON.stringify({
			repo: git.bareUrl,
			tag: FIXTURE_PACK_TAG,
			org: orgSlug,
			visibility: "public",
		}),
	})
	if (res.status !== 202) {
		throw new Error(`seedCommunityScreenedFixture: publish returned ${res.status}: ${await res.text()}`)
	}
	const body = (await res.json()) as { versionId: string }

	// Wait for the polling worker to bring the version to a
	// terminal state. The DB is polled at 200ms cadence with the
	// ceiling honored from the caller.
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const row = await pglite.query<{ status: string; tier: string }>(
			`SELECT mv.status, m.tier
			   FROM pack_versions mv
			   JOIN packs m ON m.id = mv.pack_id
			  WHERE mv.id = $1`,
			[body.versionId],
		)
		const r = row.rows[0]
		if (r && (r.status === "ready" || r.status === "failed")) {
			return {
				scope: orgSlug,
				name: FIXTURE_PACK_NAME,
				version: FIXTURE_PACK_TAG,
				versionId: body.versionId,
				status: r.status,
				tier: r.tier,
				skipped: false,
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 200))
	}

	// Timed out waiting for the worker — surface as a failed row
	// (the DB stays in `pending` / `ingesting` and the caller can
	// observe it via the catalog).
	return {
		scope: orgSlug,
		name: FIXTURE_PACK_NAME,
		version: FIXTURE_PACK_TAG,
		versionId: body.versionId,
		status: "failed",
		tier: null,
		skipped: false,
	}
}

/**
 * The script entry point. Boot the full stack, run the
 * community-screened fixture seed, then bind the HTTP listener and
 * wait for SIGINT / SIGTERM. Imported files (tests) reach for
 * `bootSeedPublishingServer` and `seedCommunityScreenedFixture`
 * directly; the bottom-of-file `import.meta.url` guard ensures
 * this block runs only when the file is the entry point.
 */
async function main(): Promise<void> {
	const httpPort = Number(process.env.HTTP_PORT ?? 4310)
	const dataDir = requireEnv("DATA_DIR")
	const credsFile = process.env.SEED_CREDS_FILE ?? `/tmp/baka-pubval-creds-${httpPort}.json`
	const seedEnabled = process.env.SEED !== "0"
	const seedOrg = process.env.SEED_ORG ?? "acme"
	const seedOrgName = process.env.SEED_ORG_NAME ?? "Acme"
	const seedWithAdminMember = process.env.SEED_WITH_ADMIN_MEMBER !== "0"
	const officialOrg = "baka"
	const screenDryRunTimeoutMs = process.env.SCREEN_DRYRUN_TIMEOUT_MS
		? Number(process.env.SCREEN_DRYRUN_TIMEOUT_MS)
		: undefined
	const workerDisabled = process.env.WORKER_DISABLED === "1"

	const harness = await bootSeedPublishingServer({
		dataDir,
		httpPort,
		officialOrg,
		credsFile,
		seed: seedEnabled,
		seedOrg,
		seedOrgName,
		seedWithAdminMember,
		screenDryRunTimeoutMs,
		workerDisabled,
	})

	// Publish the community-screened fixture on every fresh boot
	// where the worker is enabled. When the worker is disabled
	// (kill-resume flows), the row would stay pending forever, so
	// the seed step is skipped — the existing version row is still
	// served verbatim.
	if (!workerDisabled && seedEnabled) {
		const gitFixture = await createGitFixture()
		try {
			const result = await seedCommunityScreenedFixture({
				app: harness.app,
				pglite: harness.pglite,
				ownerKey: harness.ownerKey,
				orgSlug: harness.orgSlug,
				git: gitFixture,
			})
			process.stdout.write(
				`seed-publishing-server: community fixture ${result.scope}/${result.name}@${result.version} ` +
					`status=${result.status} tier=${result.tier ?? "?"} skipped=${result.skipped}\n`,
			)
			if (result.status === "failed") {
				process.stderr.write(
					`seed-publishing-server: WARNING community fixture reached status=failed; ` +
						`the catalog still has the built-in seed but the community preview states are not available. ` +
						`Inspect ${harness.credsFile.replace(/\.json$/, "")}.log or the operator stderr for the verdict text.\n`,
				)
			}
		} finally {
			await gitFixture.cleanup()
		}
	}

	const officialResult = (
		harness as SeedPublishingHarness & { _officialResult?: { created: boolean; publishersGranted: number } }
	)._officialResult

	serve({ fetch: harness.app.fetch, port: httpPort, hostname: "127.0.0.1" }, (info) => {
		process.stdout.write(
			`seed-publishing-server: listening on http://127.0.0.1:${info.port} ` +
				`(data=${dataDir}, worker=${harness.worker ? "enabled" : "disabled"}, seed=${seedEnabled}, ` +
				`dryRunTimeoutMs=${screenDryRunTimeoutMs ?? "default"}, ` +
				`officialOrg=${officialOrg} created=${officialResult?.created} granted=${officialResult?.publishersGranted}, ` +
				`creds=${credsFile})\n`,
		)
	})

	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		process.stdout.write(`seed-publishing-server: received ${signal}, shutting down\n`)
		await harness.shutdown()
		process.exit(0)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`seed-publishing-server: ${name} is required`)
	return value
}

// Run `main()` only when this file is the entry point. Imports
// from tests (vitest) reach for `bootSeedPublishingServer` and
// `seedCommunityScreenedFixture` without triggering the listener
// bootstrap, so the harness can be exercised against a fresh
// PGlite tmp dir per case.
const entryUrl = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : ""
if (entryUrl.endsWith("seed-publishing-server.ts") || entryUrl.endsWith("seed-publishing-server.js")) {
	main().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err)
		process.stderr.write(`seed-publishing-server: failed to start — ${message}\n`)
		process.exit(1)
	})
}
