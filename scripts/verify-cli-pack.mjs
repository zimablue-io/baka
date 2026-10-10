#!/usr/bin/env node
// scripts/verify-cli-pack.mjs
//
// Prove the `baka` CLI works from an install alone: pack it, install the tarball
// into a scratch directory with npm (nothing resolves through this repo), then
// run a bundled recipe in an empty project with an empty home and no model.
// This is the first run a new user has.
//
//   pnpm build && node scripts/verify-cli-pack.mjs
//
// Needs network access for the registry dependencies. Exits non-zero on the first failure.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const scratch = mkdtempSync(join(tmpdir(), "baka-cli-verify-"))
const packDir = join(scratch, "tarballs")
const install = join(scratch, "install")
const project = join(scratch, "project")
const home = join(scratch, "home")
for (const dir of [packDir, install, project, home]) mkdirSync(dir)

const run = (cmd, args, cwd, env = {}) =>
	execFileSync(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "inherit"],
		encoding: "utf-8",
	})

try {
	run("node", [join(repoRoot, "scripts", "pack.mjs"), "baka", "--out", packDir], repoRoot)
	const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"))
	if (!tarball) throw new Error("pack produced no tarball")

	writeFileSync(join(install, "package.json"), JSON.stringify({ name: "baka-consumer", private: true }))
	run("npm", ["install", "--no-audit", "--no-fund", join(packDir, tarball)], install)
	const baka = join(install, "node_modules", ".bin", "baka")
	if (!existsSync(baka)) throw new Error("the install has no baka binary")

	// A clean environment: a fresh home, and none of the machine's own BAKA_* settings.
	const env = { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home }
	for (const key of Object.keys(process.env)) if (key.startsWith("BAKA_")) env[key] = ""

	const receipt = JSON.parse(run(baka, ["run", "add-readme", "--name", "verify-app", "--json"], project, env))
	if (!receipt.ok) throw new Error(`first run failed: ${JSON.stringify(receipt.diagnostics)}`)
	if (!readFileSync(join(project, "README.md"), "utf-8").includes("# verify-app")) {
		throw new Error("the first run did not write the README")
	}
	console.log(`first run ok: ${receipt.outputTreeHash}`)
} finally {
	rmSync(scratch, { recursive: true, force: true })
}
