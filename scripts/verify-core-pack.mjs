#!/usr/bin/env node
// scripts/verify-core-pack.mjs
//
// Prove @baka/core is installable OUTSIDE the workspace: pack it, install the
// tarball into a fresh scratch project with npm (so nothing resolves through
// this repo's node_modules), then import it, run a pack from a catalog
// directory, and type-check a consumer file against its .d.ts.
//
//   pnpm build --filter @baka/core && node scripts/verify-core-pack.mjs
//
// Needs network access for the registry dependencies (zod 3, handlebars, jiti,
// zod-to-json-schema). Exits non-zero on the first failure.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const scratch = mkdtempSync(join(tmpdir(), "baka-core-verify-"))
const packDir = join(scratch, "tarballs")
const project = join(scratch, "consumer")
mkdirSync(packDir)
mkdirSync(project)

const run = (cmd, args, cwd) =>
	execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf-8" })

try {
	run("node", [join(repoRoot, "scripts", "pack.mjs"), "@baka/core", "--out", packDir], repoRoot)
	const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"))
	if (!tarball) throw new Error("pack produced no tarball")

	writeFileSync(join(project, "package.json"), JSON.stringify({ name: "core-consumer", private: true, type: "module" }))
	run("npm", ["install", "--no-audit", "--no-fund", join(packDir, tarball), "typescript@5", "@types/node@22"], project)

	// A pack in a catalog directory, run against a separate project directory.
	const catalog = join(project, "catalog")
	const out = join(project, "out")
	mkdirSync(join(catalog, "hello", "greet", "templates"), { recursive: true })
	mkdirSync(out)
	writeFileSync(
		join(catalog, "hello", "manifest.ts"),
		`export const Manifest = { name: "hello", version: "0.1.0", description: "x", dependencies: [], conflictsWith: [],
  recipes: [{ id: "greet", description: "x", requiresReasoning: false, filePatterns: [], validators: [],
    params: [{ name: "name", type: "string", required: true, description: "n", format: "slug" }] }], packValidators: [] }\n`,
	)
	writeFileSync(join(catalog, "hello", "greet", "templates", "{{name}}.md.hbs"), "hello {{name}}\n")
	writeFileSync(
		join(project, "smoke.mjs"),
		`import { createRegistry, describePacks, runRecipe } from "@baka/core"
const registry = createRegistry({ root: ${JSON.stringify(out)}, packDirs: [${JSON.stringify(catalog)}] })
const catalog = describePacks(registry)
if (catalog.packs.length !== 1) throw new Error("catalog not discovered")
const ok = await runRecipe({ registry, pack: "hello", recipe: "greet", params: { name: "ada" } })
if (!ok.ok || ok.changeset[0]?.path !== "ada.md") throw new Error("run failed: " + JSON.stringify(ok.diagnostics))
const escaped = await runRecipe({ registry, pack: "hello", recipe: "greet", params: { name: "../../x" } })
if (escaped.ok) throw new Error("a traversal name was accepted")
console.log("runtime ok:", ok.outputTreeHash)
`,
	)
	console.log(run("node", ["smoke.mjs"], project).trim())

	writeFileSync(
		join(project, "consumer.ts"),
		`import { type RecipeContext, type RecipeResult, type RecipeStep, createRegistry, runRecipe } from "@baka/core"
export const registry = createRegistry({ root: ".", packDirs: [] })
export const run: Promise<RecipeResult> = runRecipe({ registry, pack: "a", recipe: "b", params: {} })
export type Step = RecipeStep<{ name: string }, null, null>
export type Ctx = RecipeContext
`,
	)
	run(
		"npx",
		[
			"tsc",
			"--noEmit",
			"--strict",
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--target",
			"es2022",
			"consumer.ts",
		],
		project,
	)
	console.log("types ok")
	console.log(
		`@baka/core installs and runs outside the workspace (${existsSync(join(project, "node_modules", "@baka", "core")) ? "tarball" : "?"})`,
	)
} finally {
	rmSync(scratch, { recursive: true, force: true })
}
