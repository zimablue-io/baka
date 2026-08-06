import { existsSync, mkdirSync } from "node:fs"
import { serve } from "@hono/node-server"
import type { RegistryConfig } from "./config"
import app from "./index"
import { ensureSchemaVersion } from "./schema-version"

/**
 * Server bootstrap (architecture §4.1).
 *
 * Responsibilities:
 *   1. Ensure the data dir exists.
 *   2. Run the schema-version gate (decision 28, forward-only).
 *   3. Bind the Hono app to `config.port` on the configured hostname.
 *
 * Returns an `http.Server` so the caller can shut it down cleanly.
 * The process entry point (`bin.ts`) wires that to SIGINT/SIGTERM.
 */

interface ServerHandle {
	port: number
	url: () => string
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

	const gate = ensureSchemaVersion(config.dataDir)
	if (!gate.ok) {
		process.stderr.write(`baka-registry: refusing to boot — ${gate.error}\n`)
		// Hard exit: a newer-schema data dir is unrecoverable without an upgrade.
		process.exit(1)
	}

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
		close: () =>
			new Promise<void>((resolveClose, reject) => {
				server.close((err) => {
					if (err) reject(err)
					else resolveClose()
				})
			}),
	}
}
