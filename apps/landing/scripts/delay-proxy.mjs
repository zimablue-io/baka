#!/usr/bin/env node
/**
 * Tiny delay-proxy for the landing app.
 *
 * Forwards every HTTP request to a target base URL and adds a
 * configurable delay (default 1500ms) before responding. The
 * landing app is pointed at the proxy via `VITE_REGISTRY_URL`,
 * so a validator can capture the explicit loading state
 * (`data-testid="catalog-loading"`) before the catalog list
 * (`data-testid="catalog-list"`) renders (VAL-WEB-011).
 *
 * The proxy is a test fixture, NOT a production path. It runs
 * out of `apps/landing/scripts/` so future workers / validators
 * can use it without rebuilding the landing app.
 *
 * Usage:
 *   node scripts/delay-proxy.mjs \
 *     --port 4315 \
 *     --target http://localhost:4300 \
 *     --delay-ms 1500
 *
 * Defaults: --port 4315, --target http://localhost:4300, --delay-ms 1500
 */

import { createServer, request as httpRequest } from "node:http"

function parseArgs(argv) {
	const args = { port: 4315, target: "http://localhost:4300", delayMs: 1500 }
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--port") args.port = Number.parseInt(argv[++i], 10)
		else if (arg === "--target") args.target = argv[++i]
		else if (arg === "--delay-ms") args.delayMs = Number.parseInt(argv[++i], 10)
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write("Usage: delay-proxy.mjs [--port N] [--target URL] [--delay-ms N]\n")
			process.exit(0)
		}
	}
	return args
}

const { port, target, delayMs } = parseArgs(process.argv)
const targetUrl = new URL(target)

function proxyRequest(clientReq, clientRes) {
	const start = Date.now()
	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port.length > 0 ? targetUrl.port : targetUrl.protocol === "https:" ? 443 : 80,
		path: clientReq.url,
		method: clientReq.method,
		headers: { ...clientReq.headers, host: targetUrl.host },
	}
	const upstream = httpRequest(options, (upstreamRes) => {
		setTimeout(() => {
			clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
			upstreamRes.pipe(clientRes)
			const elapsed = Date.now() - start
			process.stdout.write(
				`[delay-proxy] ${clientReq.method} ${clientReq.url} → ${upstreamRes.statusCode} (${elapsed}ms wall, ${delayMs}ms added)\n`,
			)
		}, delayMs)
	})
	upstream.on("error", (err) => {
		process.stderr.write(`[delay-proxy] upstream error for ${clientReq.url}: ${err.message}\n`)
		clientRes.writeHead(502, { "content-type": "text/plain" })
		clientRes.end(`upstream error: ${err.message}`)
	})
	clientReq.pipe(upstream)
}

const server = createServer(proxyRequest)
server.listen(port, "127.0.0.1", () => {
	process.stdout.write(
		`[delay-proxy] listening on http://127.0.0.1:${port} → ${target} (delay ${delayMs}ms per response)\n`,
	)
})

function shutdown(signal) {
	process.stdout.write(`[delay-proxy] ${signal} received, closing\n`)
	server.close(() => process.exit(0))
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
