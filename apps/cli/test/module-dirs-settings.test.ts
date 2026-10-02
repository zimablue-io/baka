// Black-box tests (the built CLI as a subprocess) for the project's own module
// scope: `.baka/settings.json` `moduleDirs`. A bare command in a project that
// lists its catalog there must see that catalog and nothing else, even when a
// stray module sits in the user marketplace.
//
// Precedence: --modules-dir flag > BAKA_MODULE_DIRS > settings moduleDirs > default discovery.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const SLOT_FIXTURE = join(__dirname, "fixtures", "slot-mod")

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

function cli(argv: string[], cwd: string, bakaHome: string, env: Record<string, string> = {}): Promise<Result> {
	return new Promise((resolve) => {
		const child = spawn("node", [DIST_INDEX, ...argv], {
			cwd,
			env: {
				...process.env,
				HOME: bakaHome,
				BAKA_HOME: bakaHome,
				XDG_CONFIG_HOME: bakaHome,
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

/** A module with one template action: `greet` writes `<name>.md`; the manifest's name is the module's. */
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

function writeSettings(project: string, body: unknown): string {
	mkdirSync(join(project, ".baka"), { recursive: true })
	const file = join(project, ".baka", "settings.json")
	writeFileSync(file, JSON.stringify(body))
	return file
}

interface World {
	/** `<parent>/project`, with `.baka/settings.json` listing `../catalog`. */
	project: string
	catalog: string
	bakaHome: string
}

/** A project next to its catalog, and stray `acme-widget` and `acme-gadget` modules in the user marketplace. */
function world(settings: unknown = { moduleDirs: ["../catalog"] }): World {
	const parent = tmp("baka-mdset-")
	const project = join(parent, "project")
	const catalog = join(parent, "catalog")
	mkdirSync(project)
	mkdirSync(catalog)
	writeModule(catalog, "hello")
	const bakaHome = tmp("baka-mdset-home-")
	writeModule(join(bakaHome, "modules"), "acme-widget")
	writeModule(join(bakaHome, "modules"), "acme-gadget")
	writeSettings(project, settings)
	return { project, catalog, bakaHome }
}

const names = (stdout: string): string[] =>
	(JSON.parse(stdout) as { modules: Array<{ name: string }> }).modules.map((m) => m.name)

describe(".baka/settings.json moduleDirs", () => {
	it("is the whole module scope of a bare command: the stray user-marketplace module is not seen", async () => {
		const { project, bakaHome } = world()
		const listed = await cli(["list-modules", "--json"], project, bakaHome)
		expect(listed.code, listed.stderr).toBe(0)
		expect(names(listed.stdout)).toEqual(["hello"])
	})

	it("is what the control case lacks: without moduleDirs the stray module is discovered", async () => {
		const { project, bakaHome } = world({ packages: [] })
		const listed = await cli(["list-modules", "--json"], project, bakaHome)
		expect(names(listed.stdout)).toEqual(["acme-gadget", "acme-widget"])
	})

	it("resolves relative entries against --cwd, not the process directory", async () => {
		const { project, bakaHome } = world()
		const listed = await cli(["--cwd", project, "list-modules", "--json"], tmp("baka-mdset-elsewhere-"), bakaHome)
		expect(listed.code, listed.stderr).toBe(0)
		expect(names(listed.stdout)).toEqual(["hello"])
	})

	it("makes a bare `baka validate` pass over the project's catalog only", async () => {
		const { project, bakaHome } = world()
		const validated = await cli(["validate", "--json"], project, bakaHome)
		expect(validated.code, validated.stderr).toBe(0)
		expect(JSON.parse(validated.stdout)).toMatchObject({ valid: true, modulesDiscovered: 1 })
	})

	it("serves run, inspect, slots, fill, lock and module validate from that catalog", async () => {
		const { project, catalog, bakaHome } = world()
		const run = await cli(["run", "hello/greet", "--name", "ada", "--json"], project, bakaHome)
		expect(run.code, run.stderr).toBe(0)
		expect(readFileSync(join(project, "ada.md"), "utf-8")).toBe("hello ada\n")

		const inspected = await cli(["inspect", "hello/greet", "--json"], project, bakaHome)
		expect(inspected.code, inspected.stderr).toBe(0)

		const moduleValidated = await cli(["module", "validate", "hello", "--json"], project, bakaHome)
		expect(moduleValidated.code, moduleValidated.stderr).toBe(0)

		const locked = await cli(["lock", "--json"], project, bakaHome)
		expect(locked.code, locked.stderr).toBe(0)
		expect(Object.keys(JSON.parse(readFileSync(join(project, "baka.lock.json"), "utf-8")).modules)).toEqual(["hello"])

		const { cpSync } = await import("node:fs")
		cpSync(SLOT_FIXTURE, join(catalog, "slot-mod"), { recursive: true })
		const slots = await cli(["slots", "slot-mod/write", "--json"], project, bakaHome)
		expect(slots.code, slots.stderr).toBe(0)
		expect(JSON.parse(slots.stdout).slots.map((s: { id: string }) => s.id)).toEqual(["line"])
		const filled = await cli(
			["fill", "slot-mod/write", "--slot", "line", "--value", "A note.", "--title", "Probe"],
			project,
			bakaHome,
		)
		expect(filled.code, filled.stderr).toBe(0)
	})

	it("loses to BAKA_MODULE_DIRS, which loses to --modules-dir", async () => {
		const { project, bakaHome } = world()
		const envCatalog = tmp("baka-mdset-env-")
		writeModule(envCatalog, "from-env")
		const flagCatalog = tmp("baka-mdset-flag-")
		writeModule(flagCatalog, "from-flag")

		const viaEnv = await cli(["list-modules", "--json"], project, bakaHome, { BAKA_MODULE_DIRS: envCatalog })
		expect(names(viaEnv.stdout)).toEqual(["from-env"])
		const viaFlag = await cli(["--modules-dir", flagCatalog, "list-modules", "--json"], project, bakaHome, {
			BAKA_MODULE_DIRS: envCatalog,
		})
		expect(names(viaFlag.stdout)).toEqual(["from-flag"])
	})

	it("searches the listed directories in order, highest precedence first", async () => {
		const { project, bakaHome } = world({ moduleDirs: ["../first", "../catalog"] })
		const first = join(project, "..", "first")
		writeModule(first, "hello")
		writeModule(first, "extra")
		const listed = await cli(["list-modules", "--json"], project, bakaHome)
		expect(names(listed.stdout)).toEqual(["extra", "hello"])
		const run = await cli(["run", "hello/greet", "--name", "ada", "--dry-run", "--json"], project, bakaHome)
		expect(run.code, run.stderr).toBe(0)
	})

	it("fails a listed directory that does not exist with the file, the entry and the fix, in every module command", async () => {
		const { project, bakaHome } = world({ moduleDirs: ["../no-such-catalog"] })
		const file = join(project, ".baka", "settings.json")
		for (const argv of [
			["validate"],
			["list-modules"],
			["run", "hello/greet", "--name", "ada"],
			["lock"],
			["fill", "hello/greet", "--slot", "x", "--value", "y"],
			["inspect", "hello/greet"],
			["plan", "--dry-run", "anything"],
		]) {
			const result = await cli(argv, project, bakaHome)
			expect(result.code, argv.join(" ")).toBe(1)
			expect(result.stderr, argv.join(" ")).toContain(file)
			expect(result.stderr).toContain("moduleDirs[0]")
			expect(result.stderr).toContain("../no-such-catalog")
			expect(result.stderr).toMatch(/create the directory|fix the entry/)
			expect(result.stderr).not.toMatch(/\n\s+at /)
		}
		expect(existsSync(join(project, "ada.md"))).toBe(false)
		expect(existsSync(join(project, "baka.lock.json"))).toBe(false)
	})

	it("does not stop commands that do not read modules, nor a flag that names another catalog", async () => {
		const { project, bakaHome } = world({ moduleDirs: ["../no-such-catalog"] })
		const packages = await cli(["list-packages"], project, bakaHome)
		expect(packages.code, packages.stderr).toBe(0)
		const catalog = tmp("baka-mdset-flag-")
		writeModule(catalog, "from-flag")
		const listed = await cli(["--modules-dir", catalog, "list-modules", "--json"], project, bakaHome)
		expect(names(listed.stdout)).toEqual(["from-flag"])
	})

	it("survives `baka install`, which rewrites the same settings file", async () => {
		const { project, bakaHome } = world({ moduleDirs: ["../catalog"], registries: ["http://localhost:1"] })
		const source = tmp("baka-mdset-src-")
		writeModule(source, "installed-mod")
		const installed = await cli(["install", join(source, "installed-mod")], project, bakaHome)
		expect(installed.code, installed.stderr).toBe(0)
		const settings = JSON.parse(readFileSync(join(project, ".baka", "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>
		expect(settings.moduleDirs).toEqual(["../catalog"])
		expect(settings.registries).toEqual(["http://localhost:1"])
	})
})
