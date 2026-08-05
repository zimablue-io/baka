#!/usr/bin/env node
// Repo-root `pnpm baka` wrapper.
//
// Two responsibilities:
//
//   1. Strip one leading "--" that pnpm appends to argv when the caller
//      uses the documented `pnpm baka -- <cmd>` form. Forwarded verbatim,
//      that "--" reaches commander, which treats everything after it as
//      operands and fails with `error: unknown command '--'`.
//
//   2. Pass the invoker's cwd to the spawned CLI. pnpm's `--filter` runs
//      the inner `tsx src/index.ts` with cwd set to `apps/cli`, so the
//      global --cwd default would otherwise be the package directory
//      rather than the directory the user invoked baka from. `INIT_CWD`
//      (when pnpm sets it) names the invoker's directory; fall back to
//      `process.cwd()` if absent. The wrapper injects `--cwd <invoker>`
//      into argv unless the caller already supplied `--cwd`.

import { spawnSync } from "node:child_process"

const args = process.argv.slice(2)
if (args[0] === "--") args.shift()

const invokerCwd = process.env.INIT_CWD ?? process.cwd()
const hasCwdFlag = args.includes("--cwd")
const forwarded = hasCwdFlag ? args : ["--cwd", invokerCwd, ...args]

const result = spawnSync("pnpm", ["--filter", "baka", "exec", "tsx", "src/index.ts", ...forwarded], {
	stdio: "inherit",
})

if (result.error) {
	console.error(`baka: failed to launch the CLI: ${result.error.message}`)
	process.exit(2)
}
process.exit(result.status ?? 1)
