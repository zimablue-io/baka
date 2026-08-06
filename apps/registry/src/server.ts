import { existsSync, mkdirSync } from "node:fs"
import { serve } from "@hono/node-server"
import { type BetterAuthHandle, createBetterAuth } from "./auth/better-auth"
import { createPgPool } from "./auth/kysely-db"
import type { RegistryConfig } from "./config"
import { createDatabase, type DatabaseHandle } from "./db/client"
import { buildApp } from "./index"
import { ensureSchemaVersion } from "./schema-version"

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
	})
	await betterAuth.ensureTables()

	const app = buildApp({ auth: betterAuth.auth, pglite: database.pglite })

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

	return {
		port: actualPort,
		url,
		database,
		betterAuth,
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
