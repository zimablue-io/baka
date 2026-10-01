import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ModuleRegistry } from "./registry.js"

// ---------------------------------------------------------------------------
// Discovery-unification contract tests for ModuleRegistry.discover().
// Pins the single-implementation behaviors the plan/validate/list surfaces
// rely on: four scopes, deterministic output, project-wins dedup, malformed
// entries tolerated, cross-module action-id collision detection.
// ---------------------------------------------------------------------------

const cleanup: string[] = []
const prevHome = process.env.HOME

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	cleanup.push(dir)
	return dir
}

afterEach(() => {
	process.env.HOME = prevHome
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

beforeEach(() => {
	// Hermetic user scope: point HOME at a fresh empty dir so the real
	// ~/.baka never leaks into discovery.
	process.env.HOME = makeTempDir("baka-disc-home-")
})

function manifestSource(name: string, opts: { description?: string; actionIds?: string[] } = {}): string {
	const description = opts.description ?? "fixture"
	const actionIds = opts.actionIds ?? ["act"]
	const actions = actionIds
		.map(
			(id) =>
				`{ id: "${id}", description: "${id}", params: [], requiresReasoning: false, filePatterns: [], validators: [] }`,
		)
		.join(", ")
	return `import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "${name}",
	version: "0.1.0",
	description: "${description}",
	dependencies: [],
	conflictsWith: [],
	actions: [${actions}],
	moduleValidators: [],
}
`
}

/** Write a valid fixture module (manifest + action stubs) into `moduleDir`. */
function writeFixtureModule(
	moduleDir: string,
	name: string,
	opts: { description?: string; actionIds?: string[] } = {},
): void {
	mkdirSync(moduleDir, { recursive: true })
	writeFileSync(join(moduleDir, "manifest.ts"), manifestSource(name, opts))
	for (const id of opts.actionIds ?? ["act"]) {
		mkdirSync(join(moduleDir, id), { recursive: true })
		writeFileSync(join(moduleDir, id, "action.ts"), "export const actAction = {}\n")
	}
}

describe("ModuleRegistry.discover — project scope wins over user scope", () => {
	it("serves the project copy exactly once when the same module is in both scopes", () => {
		const root = makeTempDir("baka-disc-dedup-root-")
		const home = process.env.HOME as string
		writeFixtureModule(join(home, ".baka", "modules", "dup-mod"), "dup-mod", { description: "USER VERSION" })
		writeFixtureModule(join(root, ".baka", "modules", "dup-mod"), "dup-mod", { description: "PROJECT VERSION" })

		const first = new ModuleRegistry(root).discover()
		const second = new ModuleRegistry(root).discover()

		const matches = first.modules.filter((m) => m.name === "dup-mod")
		expect(matches).toHaveLength(1)
		expect(matches[0].description).toBe("PROJECT VERSION")
		expect(JSON.stringify(first.modules)).toBe(JSON.stringify(second.modules))
	})
})

describe("ModuleRegistry.discover — dedup across tree and project scopes", () => {
	it("lists the module once, with the project copy winning", () => {
		const root = makeTempDir("baka-disc-treeproj-")
		writeFixtureModule(join(root, "modules", "dup-mod"), "dup-mod", { description: "TREE VERSION" })
		writeFixtureModule(join(root, ".baka", "modules", "dup-mod"), "dup-mod", { description: "PROJECT VERSION" })

		const { modules } = new ModuleRegistry(root).discover()
		const matches = modules.filter((m) => m.name === "dup-mod")
		expect(matches).toHaveLength(1)
		expect(matches[0].description).toBe("PROJECT VERSION")
	})
})

describe("ModuleRegistry.discover — deterministic output", () => {
	it("returns byte-identical, name-sorted module lists across runs", () => {
		const root = makeTempDir("baka-disc-order-")
		writeFixtureModule(join(root, "modules", "zeta-mod"), "zeta-mod")
		writeFixtureModule(join(root, "modules", "alpha-mod"), "alpha-mod")
		writeFixtureModule(join(root, ".baka", "modules", "mid-mod"), "mid-mod")

		const first = new ModuleRegistry(root).discover()
		const second = new ModuleRegistry(root).discover()
		const third = new ModuleRegistry(root).discover()

		const names = first.modules.map((m) => m.name)
		expect(names).toEqual(["alpha-mod", "mid-mod", "zeta-mod"])
		expect(JSON.stringify(first.modules)).toBe(JSON.stringify(second.modules))
		expect(JSON.stringify(second.modules)).toBe(JSON.stringify(third.modules))
	})
})

describe("ModuleRegistry.discover — malformed entries never crash discovery", () => {
	it("skips a syntactically invalid manifest, a dangling symlink, and an empty dir with diagnostics", () => {
		const root = makeTempDir("baka-disc-malformed-")
		const marketDir = join(root, ".baka", "modules")
		mkdirSync(marketDir, { recursive: true })

		// (a) syntactically invalid manifest.ts
		const badSyntax = join(marketDir, "broken-syntax")
		mkdirSync(badSyntax, { recursive: true })
		writeFileSync(join(badSyntax, "manifest.ts"), "export const Manifest = {{{ not valid ts\n")

		// (b) dangling symlink
		symlinkSync(join(marketDir, "does-not-exist"), join(marketDir, "dangling-link"))

		// (c) empty directory
		mkdirSync(join(marketDir, "empty-dir"), { recursive: true })

		// (d) one valid module alongside the broken entries
		writeFixtureModule(join(marketDir, "good-mod"), "good-mod", { description: "the valid one" })

		const { modules, diagnostics } = new ModuleRegistry(root).discover()

		expect(modules.map((m) => m.name)).toEqual(["good-mod"])
		for (const broken of ["broken-syntax", "dangling-link", "empty-dir"]) {
			expect(
				diagnostics.some((d) => d.message.includes(broken)),
				`expected a diagnostic naming ${broken}`,
			).toBe(true)
		}
	})

	it("survives a modules scope path that is a file, not a directory", () => {
		const root = makeTempDir("baka-disc-notdir-")
		mkdirSync(join(root, ".baka"), { recursive: true })
		writeFileSync(join(root, ".baka", "modules"), "not a directory\n")
		writeFixtureModule(join(root, "modules", "tree-mod"), "tree-mod")

		const { modules, diagnostics } = new ModuleRegistry(root).discover()
		expect(modules.map((m) => m.name)).toContain("tree-mod")
		expect(diagnostics.some((d) => d.severity === "warning")).toBe(true)
	})
})

describe("ModuleRegistry.discover — no leaked repo catalog", () => {
	it("does not inject git-checkout modules into an unrelated project", () => {
		const root = makeTempDir("baka-disc-bundled-")
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-project", version: "0.0.0" }))

		const { modules } = new ModuleRegistry(root).discover()
		expect(modules.map((m) => m.name)).toEqual([])
	})

	it("stays silent in a truly empty directory", () => {
		const root = makeTempDir("baka-disc-empty-")
		const { modules, diagnostics } = new ModuleRegistry(root).discover()
		expect(modules).toEqual([])
		expect(diagnostics.some((d) => d.rule === "no-modules")).toBe(true)
	})

	it("tree scope lists modules that actually live in the project", () => {
		const root = makeTempDir("baka-disc-treewins-")
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-project", version: "0.0.0" }))
		writeFixtureModule(join(root, "modules", "note-mod"), "note-mod", { description: "TREE VERSION" })

		const { modules } = new ModuleRegistry(root).discover()
		const found = modules.find((m) => m.name === "note-mod")
		expect(found?.description).toBe("TREE VERSION")
	})
})

describe("ModuleRegistry.discover — user scope", () => {
	it("discovers modules from the user marketplace", () => {
		const root = makeTempDir("baka-disc-user-root-")
		const home = process.env.HOME as string
		writeFixtureModule(join(home, ".baka", "modules", "user-mod"), "user-mod", { description: "user-scope module" })

		const { modules } = new ModuleRegistry(root).discover()
		const found = modules.find((m) => m.name === "user-mod")
		expect(found?.description).toBe("user-scope module")
	})
})

describe("ModuleRegistry.actionIdCollisions", () => {
	it("reports action ids exported by two different modules, naming both", () => {
		const root = makeTempDir("baka-disc-collide-")
		writeFixtureModule(join(root, "modules", "mod-a"), "mod-a", { actionIds: ["collide", "unique-a"] })
		writeFixtureModule(join(root, "modules", "mod-b"), "mod-b", { actionIds: ["collide"] })

		const registry = new ModuleRegistry(root)
		const { modules } = registry.discover()
		// Discovery itself succeeds: both modules are listed.
		expect(modules.map((m) => m.name)).toEqual(["mod-a", "mod-b"])

		const collisions = registry.actionIdCollisions()
		expect(collisions.get("collide")).toEqual(["mod-a", "mod-b"])
		expect(collisions.has("unique-a")).toBe(false)
	})

	it("does not flag an action id when the same module owns it across scopes", () => {
		const root = makeTempDir("baka-disc-same-mod-")
		const home = process.env.HOME as string
		writeFixtureModule(join(home, ".baka", "modules", "dup-mod"), "dup-mod", { actionIds: ["act"] })
		writeFixtureModule(join(root, ".baka", "modules", "dup-mod"), "dup-mod", { actionIds: ["act"] })

		const registry = new ModuleRegistry(root)
		registry.discover()
		expect(registry.actionIdCollisions().size).toBe(0)
	})
})
