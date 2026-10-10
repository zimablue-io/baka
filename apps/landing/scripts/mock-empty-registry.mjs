#!/usr/bin/env node
/**
 * Mock registry for testing the landing app's empty catalog UI.
 * Returns {"packs":[]} on GET /v1/packs so the landing app
 * can render its explicit empty state (data-testid="catalog-empty").
 *
 * Usage:
 *   node scripts/mock-empty-registry.mjs --port 4320
 */

import { createServer } from "node:http"

function parseArgs(argv) {
	const args = { port: 4320 }
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === "--port") args.port = Number.parseInt(argv[++i], 10)
		else if (argv[i] === "--help" || argv[i] === "-h") {
			process.stdout.write("Usage: mock-empty-registry.mjs [--port N]\n")
			process.exit(0)
		}
	}
	return args
}

const { port } = parseArgs(process.argv)
const routes = {
	"/healthz": (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ status: "ok" }))
	},
	"/v1/packs": (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ packs: [] }))
	},
	"/v1/packs/:scope/:name": (_req, res) => {
		res.writeHead(404, { "content-type": "application/json" })
		res.end(JSON.stringify({ error: "not found" }))
	},
	"/v1/packs/:scope/:name/versions/:version": (_req, res) => {
		res.writeHead(404, { "content-type": "application/json" })
		res.end(JSON.stringify({ error: "not found" }))
	},
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
	res.setHeader("access-control-allow-origin", "*")
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
			"access-control-allow-headers": "Content-Type, Accept, Authorization, X-API-Key",
		})
		res.end()
		return
	}
	const handler = routes[url.pathname]
	if (handler) {
		handler(req, res)
		process.stdout.write(`[mock-empty] ${req.method} ${url.pathname} → ${res.statusCode}\n`)
		return
	}
	res.writeHead(404, { "content-type": "application/json" })
	res.end(JSON.stringify({ error: "not found", path: url.pathname }))
})

server.listen(port, "127.0.0.1", () => {
	process.stdout.write(`[mock-empty] listening on http://127.0.0.1:${port}\n`)
})

function shutdown(signal) {
	process.stdout.write(`[mock-empty] ${signal} received, closing\n`)
	server.close(() => process.exit(0))
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
