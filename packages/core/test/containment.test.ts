import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compensateRecipe, createRegistry, runRecipe } from "../src/index.js"
import { cleanupTempDirs, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

/** `base/project` is the project root, so `..` from it lands in `base`. */
function setup(extra: { recipeTs?: string; nameParam?: Record<string, unknown> } = {}) {
	const base = tempDir()
	const root = join(base, "project")
	mkdirSync(root)
	const packs = tempDir()
	writePack(packs, {
		name: "scaf",
		recipes: [
			{
				id: "scaffold",
				params: [
					{ name: "dir", type: "string", required: false, description: "parent", default: "packages" },
					{ name: "name", type: "string", required: true, description: "package name", ...extra.nameParam },
				],
				templates: {
					"{{dir}}/{{name}}/README.md.hbs": "# {{name}}\n",
					"{{dir}}/{{name}}/src/index.ts.hbs": "export {}\n",
				},
				recipeTs: extra.recipeTs,
			},
		],
	})
	return { base, root, registry: createRegistry({ root, packDirs: [packs] }) }
}

const run = (registry: ReturnType<typeof setup>["registry"], params: Record<string, unknown>, dryRun = false) =>
	runRecipe({ registry, pack: "scaf", recipe: "scaffold", params, dryRun })

describe("template paths cannot leave the project root", () => {
	it("--name ../../x is refused, writes nothing, and leaves nothing outside the root", async () => {
		const { base, root, registry } = setup()
		const result = await run(registry, { name: "../../x" })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(result.diagnostics[0]?.message).toContain("..")
		expect(result.changeset).toEqual([])
		expect(result.compensation).toEqual({ created: [], createdDirs: [], overwritten: [], recipeData: null })
		expect(readdirSync(base)).toEqual(["project"])
		expect(readdirSync(root)).toEqual([])
	})

	it("refuses the same name in a dry run", async () => {
		const { base, registry } = setup()
		const result = await run(registry, { name: "../../x" }, true)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(readdirSync(base)).toEqual(["project"])
	})

	it("refuses a name that only dips out and back in, and an absolute name", async () => {
		const { root, registry } = setup()
		expect((await run(registry, { name: "a/../b" })).diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect((await run(registry, { dir: "/tmp/baka-abs", name: "x" })).diagnostics.map((d) => d.rule)).toEqual([
			"path-escape",
		])
		expect((await run(registry, { name: "a\\b" })).diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(readdirSync(root)).toEqual([])
	})

	it("an empty dir param renders an absolute path and is refused too", async () => {
		const { root, registry } = setup()
		const result = await run(registry, { dir: "", name: "x" })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(readdirSync(root)).toEqual([])
	})

	it("refuses a template that renders into .git or .baka", async () => {
		const { root, registry } = setup()
		expect((await run(registry, { dir: ".git", name: "hooks" })).diagnostics.map((d) => d.rule)).toEqual([
			"path-escape",
		])
		expect((await run(registry, { dir: ".baka", name: "packs" })).diagnostics.map((d) => d.rule)).toEqual([
			"path-escape",
		])
		expect(readdirSync(root)).toEqual([])
	})

	it("refuses a path that goes through a symlink pointing outside the root", async () => {
		const { base, root, registry } = setup()
		const outside = join(base, "outside")
		mkdirSync(outside)
		symlinkSync(outside, join(root, "packages"))
		const result = await run(registry, { name: "x" })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(readdirSync(outside)).toEqual([])
	})

	it("refuses a target that is a symlink, so a write cannot land on the file it points at", async () => {
		const { base, root, registry } = setup()
		const victim = join(base, "victim.md")
		writeFileSync(victim, "keep me\n")
		mkdirSync(join(root, "packages", "x"), { recursive: true })
		symlinkSync(victim, join(root, "packages", "x", "README.md"))
		const result = await run(registry, { name: "x" })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(readdirSync(base).sort()).toEqual(["project", "victim.md"])
	})

	it("a legitimate scaffold still works and records the directories it created", async () => {
		const { root, registry } = setup()
		const result = await run(registry, { name: "ui" })
		expect(result.ok).toBe(true)
		expect(result.changeset.map((e) => e.path)).toEqual(["packages/ui/README.md", "packages/ui/src/index.ts"])
		expect(result.compensation.createdDirs).toEqual(["packages", "packages/ui", "packages/ui/src"])
		await compensateRecipe({ registry, pack: "scaf", recipe: "scaffold", compensation: result.compensation })
		expect(readdirSync(root)).toEqual([])
	})
})

describe("rollback leaves nothing behind", () => {
	const FAILING_RECIPE = `export const scaffold = {
	name: "scaf.scaffold",
	execute: async () => ({ success: false, output: null, compensationData: null, error: "nope" }),
	compensate: async () => {},
}
`

	it("removes the files and every directory a failed run created, keeping directories that existed", async () => {
		const { root, registry } = setup({ recipeTs: FAILING_RECIPE })
		mkdirSync(join(root, "packages"))
		const result = await run(registry, { name: "ui" })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["recipe-failed"])
		expect(result.changeset).toEqual([])
		expect(readdirSync(root)).toEqual(["packages"])
		expect(readdirSync(join(root, "packages"))).toEqual([])
	})

	it("removes them all in a fresh project", async () => {
		const { root, registry } = setup({ recipeTs: FAILING_RECIPE })
		await run(registry, { name: "ui" })
		expect(readdirSync(root)).toEqual([])
	})

	it("compensateRecipe refuses a forged receipt whose paths leave the root", async () => {
		const { base, registry } = setup()
		const victim = join(base, "victim.txt")
		writeFileSync(victim, "keep me\n")
		await expect(
			compensateRecipe({
				registry,
				pack: "scaf",
				recipe: "scaffold",
				compensation: { created: ["../victim.txt"], createdDirs: [], overwritten: [], recipeData: null },
			}),
		).rejects.toThrow(/path-escape|\.\./)
		expect(existsSync(victim)).toBe(true)
	})
})

describe("string param constraints are enforced before anything runs", () => {
	it("format: slug rejects a traversal name with invalid-params", async () => {
		const { root, registry } = setup({ nameParam: { format: "slug" } })
		const result = await run(registry, { name: "../../x" })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["invalid-params"])
		expect(result.diagnostics[0]?.message).toContain("name")
		expect(readdirSync(root)).toEqual([])
		expect((await run(registry, { name: "ui" })).ok).toBe(true)
	})

	it("pattern, minLength and maxLength", async () => {
		const { registry } = setup({ nameParam: { pattern: "^[a-z]+$", minLength: 2, maxLength: 4 } })
		for (const bad of ["A", "a", "abcde", "ab1"]) {
			expect((await run(registry, { name: bad })).diagnostics.map((d) => d.rule)).toEqual(["invalid-params"])
		}
		expect((await run(registry, { name: "abcd" })).ok).toBe(true)
	})

	it("format: path-segment forbids separators and dot segments", async () => {
		const { registry } = setup({ nameParam: { format: "path-segment" } })
		for (const bad of ["..", ".", "a/b", "a\\b", ""]) {
			expect((await run(registry, { name: bad })).diagnostics.map((d) => d.rule)).toEqual(["invalid-params"])
		}
		expect((await run(registry, { name: "my.pkg" })).ok).toBe(true)
	})
})
