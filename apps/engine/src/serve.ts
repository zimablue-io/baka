import { delimiter, resolve } from "node:path"
import { serve } from "@hono/node-server"
import { moduleDirsFromEnv } from "@repo/ast-tooling"
import { createEngineApp } from "./app.js"

/** Env var carrying the bearer token (the `--token` flag wins over it). */
export const ENGINE_TOKEN_ENV = "BAKA_ENGINE_TOKEN"
/** Env var carrying allowed project roots, separated like PATH (`:` or `;`). Flags add to it. */
export const ENGINE_ALLOWED_ROOTS_ENV = "BAKA_ENGINE_ALLOWED_ROOTS"

const DEFAULT_ENGINE_PORT = 4311
const DEFAULT_ENGINE_HOST = "127.0.0.1"

/** True for 127.0.0.0/8, ::1, and `localhost`: addresses only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
	const h = host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
	return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h)
}

export interface ServeFlags {
	port?: number
	host?: string
	token?: string
	allowRoots?: readonly string[]
	/** Module directories (see `EngineAppOptions.moduleDirs`); they beat `BAKA_MODULE_DIRS`. */
	moduleDirs?: readonly string[]
}

export interface ServeConfig {
	port: number
	host: string
	token?: string
	allowedRoots: string[]
	moduleDirs?: string[]
}

/**
 * Merge CLI flags with the environment. A flag beats its env var for the
 * token; allowed roots from both are combined. An empty token counts as unset.
 * Throws when the bind address is reachable from other machines and no token
 * is set: the engine writes files into project directories, so it will not
 * listen openly without authentication.
 */
export function resolveServeConfig(flags: ServeFlags, env: NodeJS.ProcessEnv, cwd: string): ServeConfig {
	const host = flags.host?.trim() || DEFAULT_ENGINE_HOST
	const token = (flags.token ?? env[ENGINE_TOKEN_ENV])?.trim() || undefined
	const envRoots = (env[ENGINE_ALLOWED_ROOTS_ENV] ?? "").split(delimiter).filter((r) => r.trim() !== "")
	if (token && /\s/.test(token)) {
		throw new Error(
			"the bearer token must not contain whitespace: clients cannot present it in an Authorization header",
		)
	}
	const allowedRoots = [...envRoots, ...(flags.allowRoots ?? [])].map((root) => resolve(cwd, root))
	if (!isLoopbackHost(host) && !token) {
		throw new Error(
			`refusing to listen on ${host}: it is not a loopback address and no bearer token is set. ` +
				`Set ${ENGINE_TOKEN_ENV} or pass --token, or bind to 127.0.0.1.`,
		)
	}
	const moduleDirs = flags.moduleDirs?.length
		? flags.moduleDirs.map((dir) => resolve(cwd, dir))
		: moduleDirsFromEnv(env)
	return { port: flags.port ?? DEFAULT_ENGINE_PORT, host, token, allowedRoots, moduleDirs }
}

export interface RunningEngine {
	url: string
	port: number
	close(): Promise<void>
}

/** Start the engine's HTTP server for `cwd`; `config` comes from `resolveServeConfig`. */
export function serveEngine(cwd: string, config: ServeConfig): Promise<RunningEngine> {
	const app = createEngineApp({
		cwd,
		token: config.token,
		allowedRoots: config.allowedRoots,
		moduleDirs: config.moduleDirs,
	})
	return new Promise((resolveStart, reject) => {
		const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
			const shown = info.family === "IPv6" ? `[${info.address}]` : info.address
			resolveStart({
				url: `http://${shown}:${info.port}`,
				port: info.port,
				close: () => new Promise<void>((done) => server.close(() => done())),
			})
		})
		server.on("error", reject)
	})
}
