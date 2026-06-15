#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { startServer } from "./server.js"

async function main(): Promise<void> {
	const server = startServer({ cwd: process.cwd() })
	const transport = new StdioServerTransport()
	await server.connect(transport)
	// The server is now driven by JSON-RPC on stdio. The process must not
	// exit; the host owns the lifecycle.
}

main().catch((err) => {
	// The host reads our stdout. Never write a stack trace to stdout;
	// surface the error to stderr and exit with a non-zero code so the
	// host surfaces a connection failure.
	process.stderr.write(`baka-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(1)
})
