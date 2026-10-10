#!/usr/bin/env node
// Repo-root `pnpm baka` wrapper, and a launcher that works from any directory:
//
//   node /path/to/baka/scripts/baka.mjs --cwd . run hello/greet --name Ada
//
// It runs the CLI from source (tsx) from the INVOKER's directory, so the CLI's
// own defaults (`--cwd` is the current directory; relative `--cwd` and
// `--packs-dir` resolve against it) mean what the caller expects, whichever
// repo the caller is in. No pnpm workspace is involved: the old wrapper ran
// `pnpm --filter baka exec`, which only finds the project inside the Baka repo.
//
// Strips one leading "--" that pnpm appends when the caller uses the documented
// `pnpm baka -- <cmd>` form; commander would otherwise take it as the start of
// the operands. `INIT_CWD` (set by pnpm) names the directory the caller ran
// pnpm from; without it the current directory is used.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cliDir = join(repoRoot, "apps", "cli")

const args = process.argv.slice(2)
if (args[0] === "--") args.shift()

const invokerCwd = process.env.INIT_CWD || process.cwd()

const tsx = join(cliDir, "node_modules", ".bin", "tsx")
const source = join(cliDir, "src", "index.ts")
const built = join(cliDir, "dist", "index.js")

let command
let commandArgs
if (existsSync(tsx) && existsSync(source)) {
	command = tsx
	commandArgs = ["--tsconfig", join(cliDir, "tsconfig.json"), source, ...args]
} else if (existsSync(built)) {
	command = process.execPath
	commandArgs = [built, ...args]
} else {
	console.error(`baka: no CLI found under ${cliDir}; run \`pnpm install\` in ${repoRoot}`)
	process.exit(2)
}

const result = spawnSync(command, commandArgs, { stdio: "inherit", cwd: invokerCwd })

if (result.error) {
	console.error(`baka: failed to launch the CLI: ${result.error.message}`)
	process.exit(2)
}
process.exit(result.status ?? 1)
