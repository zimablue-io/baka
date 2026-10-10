// Black-box tests (the built CLI as a subprocess) for how the CLI separates the
// project root from the pack scope, and for the launcher:
//   - a relative --cwd works in every command (it used to crash `pack validate`);
//   - --packs-dir <dir> (repeatable) and BAKA_PACK_DIRS draw packs from a
//     catalog elsewhere, exclusively, without symlinks and without the catalog
//     ever being written to;
//   - scripts/baka.mjs works from any directory.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const BAKA_MJS = join(BAKA_REPO, "scripts", "baka.mjs")

const created: string[] = []
afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	created.push(dir)
	return dir
}

interface Result {
	code: number | null
	stdout: string
	stderr: string
}

function run(script: string, argv: string[], cwd: string, env: Record<string, string> = {}): Promise<Result> {
	const home = tmp("baka-scope-home-")
	return new Promise((resolve) => {
		const child = spawn("node", [script, ...argv], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				BAKA_HOME: home,
				XDG_CONFIG_HOME: home,
				INIT_CWD: "",
				BAKA_PACK_DIRS: "",
				...env,
			},
		})
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (b: Buffer) => {
			stdout += b.toString()
		})
		child.stderr.on("data", (b: Buffer) => {
			stderr += b.toString()
		})
		child.on("close", (code) => resolve({ code, stdout, stderr }))
	})
}

const cli = (argv: string[], cwd: string, env?: Record<string, string>) => run(DIST_INDEX, argv, cwd, env)

/** A pack with one template recipe, no slots: `greet` writes `<name>.md`. */
function writePack(dir: string, name: string): void {
	const root = join(dir, name)
	mkdirSync(join(root, "greet", "templates"), { recursive: true })
	writeFileSync(
		join(root, "manifest.ts"),
		`export const Manifest = {
  name: ${JSON.stringify(name)}, version: "0.1.0", description: "fixture", dependencies: [], conflictsWith: [],
  recipes: [{ id: "greet", description: "greet", requiresReasoning: false, filePatterns: [], validators: [],
    params: [{ name: "name", type: "string", required: true, description: "who", format: "slug" }] }],
  packValidators: [],
}
`,
	)
	writeFileSync(join(root, "greet", "templates", "{{name}}.md.hbs"), "hello {{name}}\n")
}

function tree(dir: string): string[] {
	const out: string[] = []
	const walk = (d: string, rel: string) => {
		for (const entry of readdirSync(d).sort()) {
			const abs = join(d, entry)
			const r = rel ? `${rel}/${entry}` : entry
			out.push(r)
			if (statSync(abs).isDirectory()) walk(abs, r)
		}
	}
	walk(dir, "")
	return out
}

describe("a relative --cwd", () => {
	it("works for pack validate, list-packs and run", async () => {
		const project = tmp("baka-scope-project-")
		writePack(join(project, "packs"), "hello")

		const validate = await cli(["--cwd", ".", "pack", "validate", "hello", "--json"], project)
		expect(validate.code, validate.stderr).toBe(0)
		expect(JSON.parse(validate.stdout)).toMatchObject({ pack: "hello", valid: true })

		const list = await cli(["--cwd", ".", "list-packs", "--json"], project)
		expect(JSON.parse(list.stdout).packs.map((m: { name: string }) => m.name)).toEqual(["hello"])

		const ran = await cli(["--cwd", ".", "run", "hello/greet", "--name", "ada", "--json"], project)
		expect(ran.code, ran.stderr).toBe(0)
		expect(readFileSync(join(project, "ada.md"), "utf-8")).toBe("hello ada\n")
	})

	it("resolves against the process directory: --cwd project from the parent", async () => {
		const parent = tmp("baka-scope-parent-")
		const project = join(parent, "project")
		writePack(join(project, "packs"), "hello")
		const result = await cli(["--cwd", "project", "list-packs", "--json"], parent)
		expect(JSON.parse(result.stdout).packs.map((m: { name: string }) => m.name)).toEqual(["hello"])
	})
})

describe("--packs-dir and BAKA_PACK_DIRS", () => {
	function catalogAndProject() {
		const catalog = tmp("baka-scope-catalog-")
		writePack(catalog, "hello")
		writePack(catalog, "other")
		const project = tmp("baka-scope-project-")
		return { catalog, project }
	}

	it("runs a catalog pack against another project and never writes into the catalog", async () => {
		const { catalog, project } = catalogAndProject()
		const before = tree(catalog)
		const ran = await cli(
			["--cwd", project, "--packs-dir", catalog, "run", "hello/greet", "--name", "ada", "--json"],
			tmp("baka-scope-elsewhere-"),
		)
		expect(ran.code, ran.stderr).toBe(0)
		const receipt = JSON.parse(ran.stdout) as { ok: boolean; changeset: Array<{ path: string; op: string }> }
		expect(receipt.ok).toBe(true)
		expect(receipt.changeset).toEqual([expect.objectContaining({ path: "ada.md", op: "create" })])
		expect(readFileSync(join(project, "ada.md"), "utf-8")).toBe("hello ada\n")
		expect(tree(catalog)).toEqual(before)
		expect(existsSync(join(catalog, ".baka"))).toBe(false)
		// the project gained only the output (no symlinks, no .baka/packs)
		expect(tree(project).filter((p) => !p.startsWith(".baka"))).toEqual(["ada.md"])
	})

	it("is exclusive: the project's own packs/ is not searched while a catalog is given", async () => {
		const { catalog, project } = catalogAndProject()
		writePack(join(project, "packs"), "local-only")
		const withDirs = await cli(["--cwd", project, "--packs-dir", catalog, "list-packs", "--json"], project)
		expect(JSON.parse(withDirs.stdout).packs.map((m: { name: string }) => m.name)).toEqual(["hello", "other"])
		const without = await cli(["--cwd", project, "list-packs", "--json"], project)
		expect(JSON.parse(without.stdout).packs.map((m: { name: string }) => m.name)).toEqual(["local-only"])
	})

	it("is repeatable, highest precedence first, and a relative path resolves against the process directory", async () => {
		const parent = tmp("baka-scope-parent-")
		const project = join(parent, "project")
		mkdirSync(project)
		writePack(join(parent, "first"), "shared")
		writePack(join(parent, "second"), "shared")
		writePack(join(parent, "second"), "extra")
		writeFileSync(join(parent, "second", "shared", "greet", "templates", "{{name}}.md.hbs"), "second wins?\n")
		const ran = await cli(
			["--cwd", "project", "--packs-dir", "first", "--packs-dir", "second", "run", "shared/greet", "--name", "x"],
			parent,
		)
		expect(ran.code, ran.stderr).toBe(0)
		expect(readFileSync(join(project, "x.md"), "utf-8")).toBe("hello x\n")
		const list = await cli(
			["--cwd", "project", "--packs-dir", "first", "--packs-dir", "second", "list-packs", "--json"],
			parent,
		)
		expect(JSON.parse(list.stdout).packs.map((m: { name: string }) => m.name)).toEqual(["extra", "shared"])
	})

	it("BAKA_PACK_DIRS does the same, split like PATH, and a flag beats it", async () => {
		const { catalog, project } = catalogAndProject()
		const other = tmp("baka-scope-other-")
		writePack(other, "third")
		const env = { BAKA_PACK_DIRS: [catalog, other].join(delimiter) }
		const viaEnv = await cli(["--cwd", project, "list-packs", "--json"], project, env)
		expect(JSON.parse(viaEnv.stdout).packs.map((m: { name: string }) => m.name)).toEqual(["hello", "other", "third"])
		const flagWins = await cli(["--cwd", project, "--packs-dir", other, "list-packs", "--json"], project, env)
		expect(JSON.parse(flagWins.stdout).packs.map((m: { name: string }) => m.name)).toEqual(["third"])
	})

	it("works for pack validate, pack list-recipes, pack test, slots, inspect, lock and validate", async () => {
		const { catalog, project } = catalogAndProject()
		const g = ["--cwd", project, "--packs-dir", catalog]
		expect((await cli([...g, "pack", "validate", "hello", "--json"], project)).code).toBe(0)
		expect((await cli([...g, "pack", "list-recipes", "hello"], project)).stdout).toContain("- greet:")
		const test = await cli([...g, "pack", "test", "hello", "--recipe", "greet", "--input", '{"name":"zed"}'], project)
		expect(test.code, test.stderr).toBe(0)
		expect(test.stdout).toContain("zed.md")
		expect((await cli([...g, "inspect", "hello/greet", "--json"], project)).code).toBe(0)
		expect((await cli([...g, "slots", "hello/greet", "--json"], project)).code).toBe(0)
		const lock = await cli([...g, "lock"], project)
		expect(lock.code, lock.stderr).toBe(0)
		expect(JSON.parse(readFileSync(join(project, "baka.lock.json"), "utf-8")).packs).toHaveProperty("hello")
		expect(existsSync(join(catalog, "baka.lock.json"))).toBe(false)
		const validate = await cli([...g, "validate", "--json"], project)
		expect(validate.code, validate.stderr).toBe(0)
	})

	it("a param constraint refuses a traversal name before anything is written", async () => {
		const { catalog, project } = catalogAndProject()
		const ran = await cli(
			["--cwd", project, "--packs-dir", catalog, "run", "hello/greet", "--name", "../../x", "--json"],
			project,
		)
		expect(ran.code).not.toBe(0)
		expect(JSON.parse(ran.stdout).diagnostics[0].rule).toBe("invalid-params")
		expect(tree(project).filter((p) => !p.startsWith(".baka"))).toEqual([])
	})
})

describe("pack validate enforces the types-only baka-sdk rule", () => {
	function withRecipe(source: string) {
		const catalog = tmp("baka-scope-sdk-")
		writePack(catalog, "hello")
		mkdirSync(join(catalog, "hello", "side"), { recursive: true })
		writeFileSync(join(catalog, "hello", "side", "recipe.ts"), source)
		writeFileSync(
			join(catalog, "hello", "manifest.ts"),
			`export const Manifest = {
  name: "hello", version: "0.1.0", description: "fixture", dependencies: [], conflictsWith: [],
  recipes: [{ id: "side", description: "x", requiresReasoning: false, filePatterns: [], validators: [], params: [] }],
  packValidators: [],
}
`,
		)
		return catalog
	}
	const STEP = `export const sideRecipe = { name: "x", execute: async () => ({ success: true, output: null, compensationData: null }), compensate: async () => {} }\n`

	it("accepts import type, including inline type specifiers", async () => {
		const catalog = withRecipe(
			`import { type RecipeStep } from "baka-sdk"\nimport type { OrchestrationState } from "baka-sdk"\n${STEP}`,
		)
		const result = await cli(["--packs-dir", catalog, "pack", "validate", "hello", "--json"], catalog)
		expect(result.code, result.stdout + result.stderr).toBe(0)
		expect(JSON.parse(result.stdout).valid).toBe(true)
	})

	it("accepts a runtime import when the pack owns the install (baka-sdk in package.json dependencies)", async () => {
		const catalog = withRecipe(`import { callLLMAsValidator } from "baka-sdk"\nvoid callLLMAsValidator\n${STEP}`)
		writeFileSync(
			join(catalog, "hello", "package.json"),
			JSON.stringify({ name: "hello", dependencies: { "baka-sdk": "*" } }),
		)
		const result = await cli(["--packs-dir", catalog, "pack", "validate", "hello", "--json"], catalog)
		// the static rule is satisfied; loading still needs the install the author promised
		const errors = JSON.parse(result.stdout).errors as string[]
		expect(errors.some((e) => e.includes("runtime import of"))).toBe(false)
	})

	it("rejects a runtime import with the file, the line and the fix", async () => {
		const catalog = withRecipe(`import { AgentRole } from "baka-sdk"\n${STEP}`)
		const result = await cli(["--packs-dir", catalog, "pack", "validate", "hello", "--json"], catalog)
		expect(result.code).toBe(4)
		const errors = JSON.parse(result.stdout).errors as string[]
		expect(
			errors.some((e) => e.startsWith('side/recipe.ts:1: runtime import of "baka-sdk"') && e.includes("import type")),
		).toBe(true)
	})
})

describe("scripts/baka.mjs from any directory", () => {
	it("runs the CLI from a directory outside the Baka repo, honouring a relative --cwd and --packs-dir", async () => {
		const parent = tmp("baka-scope-launch-")
		const project = join(parent, "project")
		mkdirSync(project)
		writePack(join(parent, "catalog"), "hello")
		const version = await run(BAKA_MJS, ["--version"], parent)
		expect(version.code, version.stderr).toBe(0)
		expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
		const list = await run(BAKA_MJS, ["--cwd", "project", "--packs-dir", "catalog", "list-packs", "--json"], parent)
		expect(list.code, list.stderr).toBe(0)
		expect(JSON.parse(list.stdout).packs.map((m: { name: string }) => m.name)).toEqual(["hello"])
		expect(list.stderr).not.toContain("No projects")
	})
})
