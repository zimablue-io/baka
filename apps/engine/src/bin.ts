#!/usr/bin/env node
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { resolveServeConfig, serveEngine } from "./serve.js"

/** `--name=value` flags, repeated flags collected in order. */
function flagValues(name: string): string[] {
	const prefix = `--${name}=`
	return process.argv.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length))
}

const cwd = process.cwd()
const portFlag = flagValues("port")[0] ?? process.env.PORT

try {
	const config = resolveServeConfig(
		{
			port: portFlag === undefined ? undefined : Number(portFlag),
			host: flagValues("host")[0],
			token: flagValues("token")[0],
			allowRoots: flagValues("allow-root"),
		},
		process.env,
		cwd,
	)
	const running = await serveEngine(cwd, config)
	process.stderr.write(
		`baka-engine listening on ${running.url} (cwd=${cwd}${config.token ? ", token required" : ""})\n`,
	)
} catch (err) {
	process.stderr.write(`baka-engine: ${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(BAKA_EXIT_CODE.USER_ERROR)
}

process.on("uncaughtException", (err) => {
	process.stderr.write(`baka-engine: ${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(BAKA_EXIT_CODE.ENGINE_ERROR)
})
