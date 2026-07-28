#!/usr/bin/env node
// Repo-root `pnpm baka` wrapper.
//
// pnpm appends a literal "--" to the script's argv when the caller uses
// the documented `pnpm baka -- <cmd>` form. Forwarded verbatim, that "--"
// reaches commander, which treats everything after it as operands and
// fails with `error: unknown command '--'`. Strip one leading "--" and
// forward the rest through the same tsx entry the old script used.

import { spawnSync } from "node:child_process"

const args = process.argv.slice(2)
if (args[0] === "--") args.shift()

const result = spawnSync("pnpm", ["--filter", "baka", "exec", "tsx", "src/index.ts", ...args], {
	stdio: "inherit",
})

if (result.error) {
	console.error(`baka: failed to launch the CLI: ${result.error.message}`)
	process.exit(2)
}
process.exit(result.status ?? 1)
