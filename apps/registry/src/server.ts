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
import { createFilesystemStorage, type StorageAdapter } from "./storage"

/**
 * Server bootstrap (architecture §4.1, §4.2, §4.4).
 *
 * Responsibilities:
 *   1. Ensure the data dir, storage dir, and pglite dir exist.
 *   2. Run the schema-version gate (decision 28, forward-only) — opens
 *      PGlite transiently, applies every unapplied migration, writes the
 *      gate file. Refuses to boot if the recorded version is newer.
 *   3. Open the database (in-process PGlite + Drizzle client).
 *   4. Start the pglite-socket TCP server on the configured port so
 *      graphile-worker (milestone 3) and Better-Auth's Kysely adapter
 *      (this milestone) can reach the same data. `maxConnections=10`
 *      per the verified dependency fact.
 *   5. Build the Better-Auth instance against a `pg.Pool` wired to the
 *      pglite-socket, then run Better-Auth's introspection-driven
 *      migrations so the auth tables (user, session, account,
 *      verification, organization, member, invitation, apikey) exist.
 *   6. Build the Hono app with auth + pglite wired in, and bind it to
 *      `config.port` on the configured hostname.
 *
 * Returns the live `DatabaseHandle`, the `BetterAuthHandle`, and an
 * `http.Server` handle so the caller can shut everything down cleanly.
 * The process entry point (`bin.ts`) wires that to SIGINT/SIGTERM.
 */

interface ServerHandle {
	port: number
	url: () => string
	database: DatabaseHandle
	betterAuth: BetterAuthHandle
	storage: StorageAdapter
	close: () => Promise<void>
}

/**
 * Logs a single honest startup line (architecture §8 decision-bound
 * boot contract; this is what the validation contract expects).
 */
function logStartupLine(config: RegistryConfig, version: string, actualPort: number): void {
	process.stdout.write(
		`baka-registry: listening on http://localhost:${actualPort} (data=${config.dataDir}, schema_version=${version})\n`,
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
	const officialOrgResult = await ensureOfficialOrg(database.pglite, betterAuth.auth, {
		officialOrg: config.officialOrg,
		officialPublishers: config.officialPublishers,
	})

	// Seed the built-in catalog (architecture §2 / §4.5, decision 17).
	// Inserts baka-base / sdd / ts-style under the official scope
	// (`REGISTRY_OFFICIAL_ORG`, default `baka`) at `tier: "official"`
	// and `visibility: "public"`, with one ready version per module.
	// Idempotent — a re-run against an already-seeded data dir is a
	// no-op. Bare-name resolution and the publish route map to the
	// official scope the seed uses here.
	await seedBuiltInCatalog(database.pglite, config.officialOrg)

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

	const app = buildApp({
		auth: betterAuth.auth,
		pglite: database.pglite,
		officialOrg: config.officialOrg,
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

	logStartupLine(config, gate.version, actualPort)

	const url = () => `http://127.0.0.1:${actualPort}`
	const storage = createFilesystemStorage(config.storageDir)

	return {
		port: actualPort,
		url,
		database,
		betterAuth,
		storage,
		close: () =>
			new Promise<void>((resolveClose, reject) => {
				server.close(async (err) => {
					if (err) {
						reject(err)
						return
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
