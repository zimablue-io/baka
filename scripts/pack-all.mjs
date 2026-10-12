#!/usr/bin/env node
// Pack every published package into dist-tarballs/, dependencies first.
//
//   node scripts/pack-all.mjs [--out <dir>] [--dep-base <prefix>|semver]
//
// Needs `pnpm build` first. The flags go straight to scripts/pack.mjs.
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(repoRoot, "dist-tarballs")
const rest = args.filter((_, i) => i !== outIndex && i !== outIndex + 1)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const name of ["@baka/protocol", "@baka/sdk", "@baka/core", "@baka/cli", "@baka/mcp"]) {
	execFileSync("node", [join(repoRoot, "scripts", "pack.mjs"), name, "--out", out, ...rest], { stdio: "inherit" })
}
