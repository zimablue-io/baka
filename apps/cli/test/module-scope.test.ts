// Black-box tests (the built CLI as a subprocess) for how the CLI separates the
// project root from the module scope, and for the launcher:
//   - a relative --cwd works in every command (it used to crash `module validate`);
//   - --modules-dir <dir> (repeatable) and BAKA_MODULE_DIRS draw modules from a
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
				BAKA_MODULE_DIRS: "",
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

/** A module with one template action, no slots: `greet` writes `<name>.md`. */
function writeModule(dir: string, name: string): void {
	const root = join(dir, name)
	mkdirSync(join(root, "greet", "templates"), { recursive: true })
	writeFileSync(
		join(root, "manifest.ts"),
		`export const Manifest = {
  name: ${JSON.stringify(name)}, version: "0.1.0", description: "fixture", dependencies: [], conflictsWith: [],
  actions: [{ id: "greet", description: "greet", requiresReasoning: false, filePatterns: [], validators: [],
    params: [{ name: "name", type: "string", required: true, description: "who", format: "slug" }] }],
  moduleValidators: [],
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
	it("works for module validate, list-modules and run", async () => {
		const project = tmp("baka-scope-project-")
		writeModule(join(project, "modules"), "hello")

		const validate = await cli(["--cwd", ".", "module", "validate", "hello", "--json"], project)
		expect(validate.code, validate.stderr).toBe(0)
		expect(JSON.parse(validate.stdout)).toMatchObject({ module: "hello", valid: true })

		const list = await cli(["--cwd", ".", "list-modules", "--json"], project)
		expect(JSON.parse(list.stdout).modules.map((m: { name: string }) => m.name)).toEqual(["hello"])

		const ran = await cli(["--cwd", ".", "run", "hello/greet", "--name", "ada", "--json"], project)
		expect(ran.code, ran.stderr).toBe(0)
		expect(readFileSync(join(project, "ada.md"), "utf-8")).toBe("hello ada\n")
	})

	it("resolves against the process directory: --cwd project from the parent", async () => {
		const parent = tmp("baka-scope-parent-")
		const project = join(parent, "project")
		writeModule(join(project, "modules"), "hello")
		const result = await cli(["--cwd", "project", "list-modules", "--json"], parent)
		expect(JSON.parse(result.stdout).modules.map((m: { name: string }) => m.name)).toEqual(["hello"])
	})
})

describe("--modules-dir and BAKA_MODULE_DIRS", () => {
	function catalogAndProject() {
		const catalog = tmp("baka-scope-catalog-")
		writeModule(catalog, "hello")
		writeModule(catalog, "other")
		const project = tmp("baka-scope-project-")
		return { catalog, project }
	}

	it("runs a catalog module against another project and never writes into the catalog", async () => {
		const { catalog, project } = catalogAndProject()
		const before = tree(catalog)
		const ran = await cli(
			["--cwd", project, "--modules-dir", catalog, "run", "hello/greet", "--name", "ada", "--json"],
			tmp("baka-scope-elsewhere-"),
		)
		expect(ran.code, ran.stderr).toBe(0)
		const receipt = JSON.parse(ran.stdout) as { ok: boolean; changeset: Array<{ path: string; op: string }> }
		expect(receipt.ok).toBe(true)
		expect(receipt.changeset).toEqual([expect.objectContaining({ path: "ada.md", op: "create" })])
		expect(readFileSync(join(project, "ada.md"), "utf-8")).toBe("hello ada\n")
		expect(tree(catalog)).toEqual(before)
		expect(existsSync(join(catalog, ".baka"))).toBe(false)
		// the project gained only the output (no symlinks, no .baka/modules)
		expect(tree(project).filter((p) => !p.startsWith(".baka"))).toEqual(["ada.md"])
	})

	it("is exclusive: the project's own modules/ is not searched while a catalog is given", async () => {
		const { catalog, project } = catalogAndProject()
		writeModule(join(project, "modules"), "local-only")
		const withDirs = await cli(["--cwd", project, "--modules-dir", catalog, "list-modules", "--json"], project)
		expect(JSON.parse(withDirs.stdout).modules.map((m: { name: string }) => m.name)).toEqual(["hello", "other"])
		const without = await cli(["--cwd", project, "list-modules", "--json"], project)
		expect(JSON.parse(without.stdout).modules.map((m: { name: string }) => m.name)).toEqual(["local-only"])
	})

	it("is repeatable, highest precedence first, and a relative path resolves against the process directory", async () => {
		const parent = tmp("baka-scope-parent-")
		const project = join(parent, "project")
		mkdirSync(project)
		writeModule(join(parent, "first"), "shared")
		writeModule(join(parent, "second"), "shared")
		writeModule(join(parent, "second"), "extra")
		writeFileSync(join(parent, "second", "shared", "greet", "templates", "{{name}}.md.hbs"), "second wins?\n")
		const ran = await cli(
			["--cwd", "project", "--modules-dir", "first", "--modules-dir", "second", "run", "shared/greet", "--name", "x"],
			parent,
		)
		expect(ran.code, ran.stderr).toBe(0)
		expect(readFileSync(join(project, "x.md"), "utf-8")).toBe("hello x\n")
		const list = await cli(
			["--cwd", "project", "--modules-dir", "first", "--modules-dir", "second", "list-modules", "--json"],
			parent,
		)
		expect(JSON.parse(list.stdout).modules.map((m: { name: string }) => m.name)).toEqual(["extra", "shared"])
	})

	it("BAKA_MODULE_DIRS does the same, split like PATH, and a flag beats it", async () => {
		const { catalog, project } = catalogAndProject()
		const other = tmp("baka-scope-other-")
		writeModule(other, "third")
		const env = { BAKA_MODULE_DIRS: [catalog, other].join(delimiter) }
		const viaEnv = await cli(["--cwd", project, "list-modules", "--json"], project, env)
		expect(JSON.parse(viaEnv.stdout).modules.map((m: { name: string }) => m.name)).toEqual(["hello", "other", "third"])
		const flagWins = await cli(["--cwd", project, "--modules-dir", other, "list-modules", "--json"], project, env)
		expect(JSON.parse(flagWins.stdout).modules.map((m: { name: string }) => m.name)).toEqual(["third"])
	})

	it("works for module validate, module list-actions, module test, slots, inspect, lock and validate", async () => {
		const { catalog, project } = catalogAndProject()
		const g = ["--cwd", project, "--modules-dir", catalog]
		expect((await cli([...g, "module", "validate", "hello", "--json"], project)).code).toBe(0)
		expect((await cli([...g, "module", "list-actions", "hello"], project)).stdout).toContain("- greet:")
		const test = await cli([...g, "module", "test", "hello", "--action", "greet", "--input", '{"name":"zed"}'], project)
		expect(test.code, test.stderr).toBe(0)
		expect(test.stdout).toContain("zed.md")
		expect((await cli([...g, "inspect", "hello/greet", "--json"], project)).code).toBe(0)
		expect((await cli([...g, "slots", "hello/greet", "--json"], project)).code).toBe(0)
		const lock = await cli([...g, "lock"], project)
		expect(lock.code, lock.stderr).toBe(0)
		expect(JSON.parse(readFileSync(join(project, "baka.lock.json"), "utf-8")).modules).toHaveProperty("hello")
		expect(existsSync(join(catalog, "baka.lock.json"))).toBe(false)
		const validate = await cli([...g, "validate", "--json"], project)
		expect(validate.code, validate.stderr).toBe(0)
	})

	it("a param constraint refuses a traversal name before anything is written", async () => {
		const { catalog, project } = catalogAndProject()
		const ran = await cli(
			["--cwd", project, "--modules-dir", catalog, "run", "hello/greet", "--name", "../../x", "--json"],
			project,
		)
		expect(ran.code).not.toBe(0)
		expect(JSON.parse(ran.stdout).diagnostics[0].rule).toBe("invalid-params")
		expect(tree(project).filter((p) => !p.startsWith(".baka"))).toEqual([])
	})
})

describe("module validate enforces the types-only baka-sdk rule", () => {
	function withAction(source: string) {
		const catalog = tmp("baka-scope-sdk-")
		writeModule(catalog, "hello")
		mkdirSync(join(catalog, "hello", "side"), { recursive: true })
		writeFileSync(join(catalog, "hello", "side", "action.ts"), source)
		writeFileSync(
			join(catalog, "hello", "manifest.ts"),
			`export const Manifest = {
  name: "hello", version: "0.1.0", description: "fixture", dependencies: [], conflictsWith: [],
  actions: [{ id: "side", description: "x", requiresReasoning: false, filePatterns: [], validators: [], params: [] }],
  moduleValidators: [],
}
`,
		)
		return catalog
	}
	const STEP = `export const sideAction = { name: "x", execute: async () => ({ success: true, output: null, compensationData: null }), compensate: async () => {} }\n`

	it("accepts import type, including inline type specifiers", async () => {
		const catalog = withAction(
			`import { type ActionStep } from "baka-sdk"\nimport type { OrchestrationState } from "baka-sdk"\n${STEP}`,
		)
		const result = await cli(["--modules-dir", catalog, "module", "validate", "hello", "--json"], catalog)
		expect(result.code, result.stdout + result.stderr).toBe(0)
		expect(JSON.parse(result.stdout).valid).toBe(true)
	})

	it("accepts a runtime import when the module owns the install (baka-sdk in package.json dependencies)", async () => {
		const catalog = withAction(`import { callLLMAsValidator } from "baka-sdk"\nvoid callLLMAsValidator\n${STEP}`)
		writeFileSync(
			join(catalog, "hello", "package.json"),
			JSON.stringify({ name: "hello", dependencies: { "baka-sdk": "*" } }),
		)
		const result = await cli(["--modules-dir", catalog, "module", "validate", "hello", "--json"], catalog)
		// the static rule is satisfied; loading still needs the install the author promised
		const errors = JSON.parse(result.stdout).errors as string[]
		expect(errors.some((e) => e.includes("runtime import of"))).toBe(false)
	})

	it("rejects a runtime import with the file, the line and the fix", async () => {
		const catalog = withAction(`import { AgentRole } from "baka-sdk"\n${STEP}`)
		const result = await cli(["--modules-dir", catalog, "module", "validate", "hello", "--json"], catalog)
		expect(result.code).toBe(4)
		const errors = JSON.parse(result.stdout).errors as string[]
		expect(
			errors.some((e) => e.startsWith('side/action.ts:1: runtime import of "baka-sdk"') && e.includes("import type")),
		).toBe(true)
	})
})

describe("scripts/baka.mjs from any directory", () => {
	it("runs the CLI from a directory outside the Baka repo, honouring a relative --cwd and --modules-dir", async () => {
		const parent = tmp("baka-scope-launch-")
		const project = join(parent, "project")
		mkdirSync(project)
		writeModule(join(parent, "catalog"), "hello")
		const version = await run(BAKA_MJS, ["--version"], parent)
		expect(version.code, version.stderr).toBe(0)
		expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
		const list = await run(BAKA_MJS, ["--cwd", "project", "--modules-dir", "catalog", "list-modules", "--json"], parent)
		expect(list.code, list.stderr).toBe(0)
		expect(JSON.parse(list.stdout).modules.map((m: { name: string }) => m.name)).toEqual(["hello"])
		expect(list.stderr).not.toContain("No projects")
	})
})
