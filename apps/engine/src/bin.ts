#!/usr/bin/env node
import { serve } from "@hono/node-server"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { createEngineApp } from "./app.js"

const port = Number(process.env.PORT ?? process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "4311")
const cwd = process.cwd()
const app = createEngineApp({ cwd })

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
	process.stderr.write(`baka-engine listening on http://127.0.0.1:${info.port} (cwd=${cwd})\n`)
})

process.on("uncaughtException", (err) => {
	process.stderr.write(`baka-engine: ${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(BAKA_EXIT_CODE.ENGINE_ERROR)
})
