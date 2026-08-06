import { existsSync, mkdirSync } from "node:fs"
import { serve } from "@hono/node-server"
import type { RegistryConfig } from "./config"
import { createDatabase, type DatabaseHandle } from "./db/client"
import app from "./index"
import { ensureSchemaVersion } from "./schema-version"

/**
 * Server bootstrap (architecture §4.1, §4.2).
 *
 * Responsibilities:
 *   1. Ensure the data dir, storage dir, and pglite dir exist.
 *   2. Run the schema-version gate (decision 28, forward-only) — opens
 *      PGlite transiently, applies every unapplied migration, writes the
 *      gate file. Refuses to boot if the recorded version is newer.
 *   3. Open the database (in-process PGlite + Drizzle client).
 *   4. Start the pglite-socket TCP server on the configured port so
 *      graphile-worker (milestone 3) and out-of-process clients can reach
 *      the same data. `maxConnections=10` per the verified dependency fact.
 *   5. Bind the Hono app to `config.port` on the configured hostname.
 *
 * Returns the live `DatabaseHandle` plus an `http.Server` handle so the
 * caller can shut everything down cleanly. The process entry point
 * (`bin.ts`) wires that to SIGINT/SIGTERM.
 */

interface ServerHandle {
	port: number
	url: () => string
	database: DatabaseHandle
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

	// Open the database (applies any migrations that did not run during the
	// gate — applyAppMigrations is idempotent, so this is safe) and start
	// the pglite-socket so graphile-worker can connect. The HTTP server
	// only binds after both succeed, so a socket failure keeps the HTTP
	// port free too.
	const database = await createDatabase({
		dataDir: config.pgliteDir,
		socketPort: config.pgliteSocketPort,
		socketHost: process.env.PGLITE_SOCKET_HOST ?? "127.0.0.1",
		startSocket: true,
	})

	// Bind to localhost (loopback only). The architecture exposes port 4300
	// on 0.0.0.0 only when BASE_URL implies a public host; for v1 the
	// registry is single-tenant/self-host and loopback is the correct
	// default. The `bindHost` opt-out (set via PORT_BIND env) exists for
	// container deployments.
	const bindHost = process.env.PORT_BIND ?? "127.0.0.1"

	// Start the server and resolve with the actual bound port. When
	// `port === 0` the OS picks one and the listen callback reports it
	// back; otherwise the configured value is echoed.
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
		close: () =>
			new Promise<void>((resolveClose, reject) => {
				server.close(async (err) => {
					if (err) {
						reject(err)
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
