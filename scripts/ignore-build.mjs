#!/usr/bin/env node
// The ignored build step of the Vercel projects of this repository (`ignoreCommand` in each app's vercel.json):
//
//   node ../../scripts/ignore-build.mjs <landing|dashboard>
//
// Exit code 0 skips the build, 1 builds it. A project builds when a file it uses changed since the last deployment that
// was built (Vercel's VERCEL_GIT_PREVIOUS_SHA; the parent commit when Vercel names none), and never skips on a change to
// what sets how everything installs and compiles (the lockfile, the root package.json, the workspace file, .npmrc, .nvmrc,
// the root tsconfig, turbo.json). When git cannot say what changed, it builds.

import { spawnSync } from "node:child_process"

const project = process.argv[2]
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this script is not a turbo task
const base = process.env.VERCEL_GIT_PREVIOUS_SHA || "HEAD^"

/** Paths from the repository root, so the answer does not depend on the folder Vercel runs the step in. */
const top = (paths) => paths.map((path) => `:(top)${path}`)

const EVERYTHING = top([
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	".npmrc",
	".nvmrc",
	"tsconfig.json",
	"turbo.json",
])
/** What the install site stages (`scripts/stage-site.mjs`): the packed packages, the workflows, the packs, the installer. */
const SITE = top(["apps", "packages", "workflows", "packs", "scripts", "install.sh"])

/** Whether any of `paths` differs since the base. A git that cannot compare (a base the clone lacks) counts as a change. */
const changed = (paths) =>
	spawnSync("git", ["diff", "--quiet", base, "HEAD", "--", ...paths], { stdio: "ignore" }).status !== 0

const build = () => process.exit(1)
const skip = () => process.exit(0)

if (project !== "landing" && project !== "dashboard") {
	console.error("usage: ignore-build.mjs <landing|dashboard>")
	build()
}
if (changed(EVERYTHING)) build()
if (project === "dashboard") (changed(SITE) ? build : skip)()
// The landing builds when it or a package it depends on changed: turbo-ignore reads the workspace graph.
process.exit(spawnSync("npx", ["-y", "turbo-ignore@2.9.18", "--task=build"], { stdio: "inherit" }).status === 0 ? 0 : 1)
