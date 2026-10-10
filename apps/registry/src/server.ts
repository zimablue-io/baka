import { existsSync, mkdirSync } from "node:fs"
import { serve } from "@hono/node-server"
import { type BetterAuthHandle, createBetterAuth } from "./auth/better-auth"
import { createPgPool } from "./auth/kysely-db"
import { ensureOfficialOrg } from "./auth/official-org"
import { applySeedPlans, ensureOrgPlanColumn } from "./auth/plan-limits"
import { seedBuiltInCatalog } from "./catalog/seed"
import type { RegistryConfig } from "./config"
import { createDatabase, type DatabaseHandle } from "./db/client"
import { buildApp } from "./index"
import { ensureSchemaVersion } from "./schema-version"
import { applyVerifiedPacks } from "./screening/tier-assignment"
import { createFilesystemStorage, type StorageAdapter } from "./storage"
import { createInMemoryEnqueuer, type IngestEnqueuer } from "./worker/enqueue"
import { startWorker, type WorkerHandle } from "./worker/runner"
import { bootSweepIngestingRows } from "./worker/sweep"

/**
 * Server bootstrap (architecture §4.1, §4.2, §4.4, §4.5).
 *
 * Responsibilities:
 *   1. Ensure the data dir, storage dir, and pglite dir exist.
 *   2. Run the schema-version gate (decision 28, forward-only) — opens
 *      PGlite transiently, applies every unapplied migration, writes the
 *      gate file. Refuses to boot if the recorded version is newer.
 *   3. Open the database (in-process PGlite + Drizzle client).
 *   4. Start the pglite-socket TCP server on the configured port so
 *      Better-Auth's Kysely adapter can reach the same data.
 *      `maxConnections=10` per the verified dependency fact.
 *   5. Build the Better-Auth instance against a `pg.Pool` wired to the
 *      pglite-socket, then run Better-Auth's introspection-driven
 *      migrations so the auth tables exist.
 *   6. Run the boot-time stale-ingesting sweep (VAL-PUB-028: a kill
 *      mid-ingest must not strand a version).
 *   7. Start the in-process polling worker (architecture §4.5,
 *      embedded in the same process for self-host simplicity). The
 *      worker reads `pack_versions.status='pending'` directly via
 *      `FOR UPDATE SKIP LOCKED` (decision 35; the enqueue seam is a
 *      hint, not the discovery mechanism).
 *   8. Build the Hono app with auth + pglite + enqueuer wired in, and
 *      bind it to `config.port` on the configured hostname.
 *
 * Returns the live `DatabaseHandle`, the `BetterAuthHandle`, the
 * `WorkerHandle`, and an `http.Server` handle so the caller can shut
 * everything down cleanly. The process entry point (`bin.ts`) wires
 * that to SIGINT/SIGTERM.
 */

interface ServerHandle {
	port: number
	url: () => string
	database: DatabaseHandle
	betterAuth: BetterAuthHandle
	storage: StorageAdapter
	worker: WorkerHandle | null
	close: () => Promise<void>
}

/**
 * Logs a single honest startup line (architecture §8 decision-bound
 * boot contract; this is what the validation contract expects).
 */
function logStartupLine(config: RegistryConfig, version: string, actualPort: number, workerEnabled: boolean): void {
	const workerTag = workerEnabled ? "worker=enabled" : "worker=disabled"
	process.stdout.write(
		`baka-registry: listening on http://localhost:${actualPort} (data=${config.dataDir}, schema_version=${version}, ${workerTag})\n`,
	)
}

export async function startServer(config: RegistryConfig): Promise<ServerHandle> {
	if (!existsSync(config.dataDir)) {
		mkdirSync(config.dataDir, { recursive: true })
	}
	if (!existsSync(config.storageDir)) {
		mkdirSync(config.storageDir, { recursive: true })
	}
	if (!existsSync(config.pgliteDir)) {
		mkdirSync(config.pgliteDir, { recursive: true })
	}

	const gate = await ensureSchemaVersion({
		dataDir: config.dataDir,
		pgliteDir: config.pgliteDir,
	})
	if (!gate.ok) {
		process.stderr.write(`baka-registry: refusing to boot — ${gate.error}\n`)
		// Hard exit: a newer-schema data dir is unrecoverable without an upgrade.
		process.exit(1)
	}

	const database = await createDatabase({
		dataDir: config.pgliteDir,
		socketPort: config.pgliteSocketPort,
		socketHost: process.env.PGLITE_SOCKET_HOST ?? "127.0.0.1",
		startSocket: true,
	})

	// Build the Better-Auth instance against a pg.Pool wired to the live
	// pglite-socket, then ensure its tables exist. ensureTables is
	// idempotent introspection (Better-Auth's getMigrations only issues
	// CREATE for tables that do not already exist).
	const pool = createPgPool({
		port: config.pgliteSocketPort,
		host: process.env.PGLITE_SOCKET_HOST ?? "127.0.0.1",
	})
	const betterAuth = await createBetterAuth(pool, {
		baseUrl: config.baseUrl,
		githubClientId: config.githubClientId,
		githubClientSecret: config.githubClientSecret,
		secret: config.authSecret,
		apiKeyRateLimit: config.apiKeyRateLimit,
		// Plan-limit enforcement hooks (VAL-SELF-006 step 3) run on
		// the Better-Auth organization plugin's `beforeCreateInvitation`
		// and `beforeAcceptInvitation` callbacks. They share the same
		// `checkPlanLimit()` seam the publish route uses for
		// `max_private_packs` and emit the same body shape (so the
		// api-key surface is honestly the same family of failures
		// whether the rejection came from publish or from the org
		// flow). The hooks need read access to the `member` and
		// `plan_limits` tables via the in-process PGlite handle —
		// a TCP round-trip through pglite-socket would deadlock the
		// same connection a publish-path pglite-socket query holds
		// (the ingest worker's claimer is on the same pool), so we
		// hand the hooks the in-process handle instead.
		pglite: database.pglite,
	})
	await betterAuth.ensureTables()

	// App migrations run BEFORE Better-Auth bootstraps, so the
	// `organization.plan` column could not be added by 0004_orgs_plan
	// at first boot (the table didn't exist yet). Apply it now that
	// the table exists; idempotent on subsequent boots. (VAL-AUTH-017
	// seam; the column default pins every new org to `free`.)
	await ensureOrgPlanColumn(database.pglite)

	// Operator-supplied plan overrides (architecture §8 decision 3).
	// Idempotent UPSERT; missing/extra plans vs. the migration defaults
	// are kept verbatim. A malformed value fails fast at boot with a
	// field-naming error.
	await applySeedPlans(database.pglite, config.seedPlans)

	// Official-org bootstrap (architecture §8 decisions 26 and 29).
	// Creates the official org (system-owned) if absent and grants
	// owner role to every identity listed in REGISTRY_OFFICIAL_PUBLISHERS.
	// The function is idempotent — re-running on an already-bootstrapped
	// data dir is a no-op for the org creation and an UPSERT for the
	// member rows. Publishers that fail to resolve (unknown API key, no
	// matching GitHub user) are logged and skipped — the bootstrap
	// never refuses to boot because of a bad publisher entry.
	const officialOrgResult = await ensureOfficialOrg(database.pglite, {
		officialOrg: config.officialOrg,
		officialPublishers: config.officialPublishers,
	})

	// Seed the built-in catalog (architecture §2 / §4.5, decision 17).
	// Production `BUILT_IN_CATALOG` is empty until a pack is productized.
	// Tests insert a tiny fixture via `seedCatalogPacks`.
	await seedBuiltInCatalog(database.pglite, config.officialOrg)

	// Apply the verified-packs env (architecture §8 decision 20,
	// VAL-SCAN-010). A JSON array of `scope/name` strings; the
	// seeder pins each entry's pack to the `verified` tier.
	// Runs AFTER the built-in catalog so the operator can override
	// a built-in's tier (e.g. a registry operator who wants
	// an official pack to show as `verified`).
	// The seeder is idempotent; failures (malformed JSON, invalid
	// entry shape) are logged but never refuse to boot — a typo
	// in the env must not wedge the registry.
	const verifiedResult = await applyVerifiedPacks(database.pglite, config.verifiedPacks)
	if (verifiedResult.applied > 0) {
		process.stdout.write(`baka-registry: pinned ${verifiedResult.applied} pack(s) to the verified tier\n`)
	}
	for (const failure of verifiedResult.failures) {
		process.stdout.write(`baka-registry: WARNING REGISTRY_VERIFIED_PACKS entry invalid: ${failure.error}\n`)
	}

	// Surface the official-org bootstrap outcome so the operator log
	// records what the boot did. Failures are logged, not fatal —
	// publishing-403 enforcement happens at the publish route.
	if (officialOrgResult.created) {
		process.stdout.write(`baka-registry: official org '${config.officialOrg}' created\n`)
	}
	if (officialOrgResult.publishersGranted > 0) {
		process.stdout.write(
			`baka-registry: granted owner role to ${officialOrgResult.publishersGranted} publisher(s) on '${config.officialOrg}'\n`,
		)
	}
	if (officialOrgResult.publishersFailed > 0) {
		process.stdout.write(
			`baka-registry: WARNING ${officialOrgResult.publishersFailed} publisher(s) failed to resolve on '${config.officialOrg}':\n`,
		)
		for (const outcome of officialOrgResult.publishers) {
			if (outcome.error) {
				process.stdout.write(`  - ${outcome.value.slice(0, 24)}...: ${outcome.error}\n`)
			}
		}
	}
	const skippedPublishers = officialOrgResult.publishers.filter(
		(outcome) => outcome.resolved === "github-user-id" && !outcome.granted && !outcome.error,
	)
	if (skippedPublishers.length > 0) {
		process.stdout.write(
			`baka-registry: WARNING ${skippedPublishers.length} GitHub publisher(s) skipped because no matching account was found on '${config.officialOrg}':\n`,
		)
		for (const outcome of skippedPublishers) {
			process.stdout.write(`  - github:${outcome.value}\n`)
		}
	}

	// Boot-time unconditional sweep (VAL-PUB-028). A freshly booted
	// process owns no in-flight jobs (no claim, no live process), so
	// every `ingesting` row at boot is definitionally orphaned. The
	// boot sweep resets ALL of them in a single statement so a
	// SIGKILL of a previous worker mid-job converges within the
	// worker's own poll cycle (well under the 120s contract
	// ceiling). The threshold-gated per-cycle sweep is the
	// worker's job — see `runner.ts` — and respects the configured
	// `sweepThresholdMs` (default 120s, env override below).
	const bootSweep = await bootSweepIngestingRows(database.pglite)
	if (bootSweep.rowsReset > 0) {
		process.stdout.write(`baka-registry: recovered ${bootSweep.rowsReset} ingesting row(s) from a previous run\n`)
	}

	const storage = createFilesystemStorage(config.storageDir)

	// Start the in-process polling worker UNLESS the operator
	// disabled it via `--no-worker` (architecture §4.1: "baka-registry
	// bin starts both; --no-worker flag splits them for multi-process
	// deploys"). The flag is forwarded via the WORKER_DISABLED env
	// var by bin.ts; the production binary defaults to embedded-
	// worker.
	let worker: WorkerHandle | null = null
	const enqueueIngest: IngestEnqueuer = createInMemoryEnqueuer()
	if (process.env.WORKER_DISABLED === "1") {
		// Worker disabled (split-process deploy): the in-memory
		// enqueuer records the seam for tests, but the worker is
		// not running, so rows stay `pending` until an external
		// worker process picks them up.
	} else {
		worker = await startWorker({
			pglite: database.pglite,
			storage,
			// Per-cycle sweep threshold (VAL-PUB-028). The worker
			// reads `REGISTRY_INGEST_STALE_MS` directly when this is
			// omitted; passing it through here makes the operator
			// override a first-class input to the worker rather
			// than an implicit env read. The default inside the
			// runner (and inside `sweepStaleIngestingRows` itself)
			// is 120_000 — the contract ceiling — so a healthy
			// registry converges within the ceiling without any
			// env configuration.
			sweepThresholdMs: config.ingestStaleMs,
			// Per-recipe dry-run timeout (architecture §8 decision 6).
			// Wired through to the worker so the operator knob
			// `SCREEN_DRYRUN_TIMEOUT_MS` is a first-class input to
			// the ingest pipeline rather than an implicit env read
			// at the executor level. The default (60_000, 60s) is
			// the documented ceiling; operators tighten it for
			// fast-fail tests via the env var.
			screenDryRunTimeoutMs: config.screenDryRunTimeoutMs,
		})
		// The polling worker discovers rows directly from
		// `pack_versions`; the publish endpoint still records the
		// enqueue (in-memory, since there's no separate job queue) so
		// tests that count enqueues keep working.
	}

	// The capture list inside `enqueueIngest` grows unbounded in a
	// long-lived server process; in production it is harmless (only
	// tests read it), but a periodic `reset()` is the right pattern
	// once we want to expose telemetry. For v1 the seam stays in
	// tests-only territory.

	const app = buildApp({
		auth: betterAuth.auth,
		pglite: database.pglite,
		officialOrg: config.officialOrg,
		enqueueIngest: async (versionId) => {
			await enqueueIngest.enqueue(versionId)
		},
		storage,
	})

	const bindHost = process.env.PORT_BIND ?? "127.0.0.1"

	const { actualPort, server } = await new Promise<{
		actualPort: number
		server: ReturnType<typeof serve>
	}>((resolveListen, rejectListen) => {
		try {
			const serverInstance = serve(
				{
					fetch: app.fetch,
					port: config.port,
					hostname: bindHost,
				},
				(info) => {
					resolveListen({ actualPort: info.port, server: serverInstance })
				},
			)
		} catch (err) {
			rejectListen(err as Error)
		}
	})

	logStartupLine(config, gate.version, actualPort, worker !== null)

	const url = () => `http://127.0.0.1:${actualPort}`

	return {
		port: actualPort,
		url,
		database,
		betterAuth,
		storage,
		worker,
		close: () =>
			new Promise<void>((resolveClose, reject) => {
				server.close(async (err) => {
					if (err) {
						reject(err)
						return
					}
					try {
						if (worker) {
							await worker.stop()
						}
					} catch (closeErr) {
						process.stderr.write(`[server] worker stop failed: ${(closeErr as Error).message}\n`)
					}
					try {
						await betterAuth.close()
					} catch (closeErr) {
						reject(closeErr as Error)
						return
					}
					try {
						await database.close()
					} catch (closeErr) {
						reject(closeErr as Error)
						return
					}
					resolveClose()
				})
			}),
	}
}
