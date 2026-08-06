#!/usr/bin/env node
/**
 * Bin entry point for `baka-registry` (architecture §4.1).
 *
 * Boots the Hono app on the configured port, runs the schema-version gate,
 * and stays up until SIGINT/SIGTERM. Subsequent milestones wire the
 * graphile-worker into this same process (self-host simplicity).
 *
 * Env-driven config: see `config.ts`. All defaults boot a working server
 * with zero env vars set.
 */
import { loadConfig } from "./config"
import { startServer } from "./server"

async function main(): Promise<void> {
	const config = loadConfig()
	const handle = await startServer(config)

	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		process.stdout.write(`baka-registry: received ${signal}, shutting down\n`)
		await handle.close()
		process.exit(0)
	}

	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err)
	process.stderr.write(`baka-registry: failed to start — ${message}\n`)
	process.exit(1)
})
