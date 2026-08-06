#!/usr/bin/env node
/**
 * Bin entry point for `baka-registry` (architecture §4.1, §4.5).
 *
 * Boots the Hono app on the configured port, runs the schema-version gate,
 * and stays up until SIGINT/SIGTERM. The polling-loop ingest worker is
 * embedded in the same process by default (self-host simplicity,
 * decision 35); the `--no-worker` flag splits them for multi-process
 * deploys (e.g. a dedicated worker host pointed at the registry's
 * pglite-socket).
 *
 * Env-driven config: see `config.ts`. All defaults boot a working server
 * with zero env vars set.
 */
import { loadConfig } from "./config"
import { startServer } from "./server"

async function main(): Promise<void> {
	// `--no-worker` is read directly from `process.argv` so the
	// command-line flag mirrors the env-driven knob the server reads.
	// Splitting the worker into its own process is documented in
	// architecture §4.1; the binary accepts both forms.
	if (process.argv.includes("--no-worker")) {
		process.env.WORKER_DISABLED = "1"
	}
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
