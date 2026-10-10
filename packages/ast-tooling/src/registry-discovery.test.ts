import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PackRegistry } from "./registry.js"

// ---------------------------------------------------------------------------
// Discovery-unification contract tests for PackRegistry.discover().
// Pins the single-implementation behaviors the plan/validate/list surfaces
// rely on: four scopes, deterministic output, project-wins dedup, malformed
// entries tolerated, cross-pack recipe-id collision detection.
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

function manifestSource(name: string, opts: { description?: string; recipeIds?: string[] } = {}): string {
	const description = opts.description ?? "fixture"
	const recipeIds = opts.recipeIds ?? ["act"]
	const recipes = recipeIds
		.map(
			(id) =>
				`{ id: "${id}", description: "${id}", params: [], requiresReasoning: false, filePatterns: [], validators: [] }`,
		)
		.join(", ")
	return `import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "${name}",
	version: "0.1.0",
	description: "${description}",
	dependencies: [],
	conflictsWith: [],
	recipes: [${recipes}],
	packValidators: [],
}
`
}

/** Write a valid fixture pack (manifest + recipe stubs) into `packDir`. */
function writeFixturePack(
	packDir: string,
	name: string,
	opts: { description?: string; recipeIds?: string[] } = {},
): void {
	mkdirSync(packDir, { recursive: true })
	writeFileSync(join(packDir, "manifest.ts"), manifestSource(name, opts))
	for (const id of opts.recipeIds ?? ["act"]) {
		mkdirSync(join(packDir, id), { recursive: true })
		writeFileSync(join(packDir, id, "recipe.ts"), "export const actRecipe = {}\n")
	}
}

describe("PackRegistry.discover — project scope wins over user scope", () => {
	it("serves the project copy exactly once when the same pack is in both scopes", () => {
		const root = makeTempDir("baka-disc-dedup-root-")
		const home = process.env.HOME as string
		writeFixturePack(join(home, ".baka", "packs", "dup-mod"), "dup-mod", { description: "USER VERSION" })
		writeFixturePack(join(root, ".baka", "packs", "dup-mod"), "dup-mod", { description: "PROJECT VERSION" })

		const first = new PackRegistry(root).discover()
		const second = new PackRegistry(root).discover()

		const matches = first.packs.filter((m) => m.name === "dup-mod")
		expect(matches).toHaveLength(1)
		expect(matches[0].description).toBe("PROJECT VERSION")
		expect(JSON.stringify(first.packs)).toBe(JSON.stringify(second.packs))
	})
})

describe("PackRegistry.discover — dedup across tree and project scopes", () => {
	it("lists the pack once, with the project copy winning", () => {
		const root = makeTempDir("baka-disc-treeproj-")
		writeFixturePack(join(root, "packs", "dup-mod"), "dup-mod", { description: "TREE VERSION" })
		writeFixturePack(join(root, ".baka", "packs", "dup-mod"), "dup-mod", { description: "PROJECT VERSION" })

		const { packs } = new PackRegistry(root).discover()
		const matches = packs.filter((m) => m.name === "dup-mod")
		expect(matches).toHaveLength(1)
		expect(matches[0].description).toBe("PROJECT VERSION")
	})
})

describe("PackRegistry.discover — deterministic output", () => {
	it("returns byte-identical, name-sorted pack lists across runs", () => {
		const root = makeTempDir("baka-disc-order-")
		writeFixturePack(join(root, "packs", "zeta-mod"), "zeta-mod")
		writeFixturePack(join(root, "packs", "alpha-mod"), "alpha-mod")
		writeFixturePack(join(root, ".baka", "packs", "mid-mod"), "mid-mod")

		const first = new PackRegistry(root).discover()
		const second = new PackRegistry(root).discover()
		const third = new PackRegistry(root).discover()

		const names = first.packs.map((m) => m.name)
		expect(names).toEqual(["alpha-mod", "mid-mod", "zeta-mod"])
		expect(JSON.stringify(first.packs)).toBe(JSON.stringify(second.packs))
		expect(JSON.stringify(second.packs)).toBe(JSON.stringify(third.packs))
	})
})

describe("PackRegistry.discover — malformed entries never crash discovery", () => {
	it("skips a syntactically invalid manifest, a dangling symlink, and an empty dir with diagnostics", () => {
		const root = makeTempDir("baka-disc-malformed-")
		const marketDir = join(root, ".baka", "packs")
		mkdirSync(marketDir, { recursive: true })

		// (a) syntactically invalid manifest.ts
		const badSyntax = join(marketDir, "broken-syntax")
		mkdirSync(badSyntax, { recursive: true })
		writeFileSync(join(badSyntax, "manifest.ts"), "export const Manifest = {{{ not valid ts\n")

		// (b) dangling symlink
		symlinkSync(join(marketDir, "does-not-exist"), join(marketDir, "dangling-link"))

		// (c) empty directory
		mkdirSync(join(marketDir, "empty-dir"), { recursive: true })

		// (d) one valid pack alongside the broken entries
		writeFixturePack(join(marketDir, "good-mod"), "good-mod", { description: "the valid one" })

		const { packs, diagnostics } = new PackRegistry(root).discover()

		expect(packs.map((m) => m.name)).toEqual(["good-mod"])
		for (const broken of ["broken-syntax", "dangling-link", "empty-dir"]) {
			expect(
				diagnostics.some((d) => d.message.includes(broken)),
				`expected a diagnostic naming ${broken}`,
			).toBe(true)
		}
	})

	it("survives a packs scope path that is a file, not a directory", () => {
		const root = makeTempDir("baka-disc-notdir-")
		mkdirSync(join(root, ".baka"), { recursive: true })
		writeFileSync(join(root, ".baka", "packs"), "not a directory\n")
		writeFixturePack(join(root, "packs", "tree-mod"), "tree-mod")

		const { packs, diagnostics } = new PackRegistry(root).discover()
		expect(packs.map((m) => m.name)).toContain("tree-mod")
		expect(diagnostics.some((d) => d.severity === "warning")).toBe(true)
	})
})

describe("PackRegistry.discover — no leaked repo catalog", () => {
	it("does not inject git-checkout packs into an unrelated project", () => {
		const root = makeTempDir("baka-disc-bundled-")
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-project", version: "0.0.0" }))

		const { packs } = new PackRegistry(root).discover()
		expect(packs.map((m) => m.name)).toEqual([])
	})

	it("stays silent in a truly empty directory", () => {
		const root = makeTempDir("baka-disc-empty-")
		const { packs, diagnostics } = new PackRegistry(root).discover()
		expect(packs).toEqual([])
		expect(diagnostics.some((d) => d.rule === "no-packs")).toBe(true)
	})

	it("tree scope lists packs that actually live in the project", () => {
		const root = makeTempDir("baka-disc-treewins-")
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-project", version: "0.0.0" }))
		writeFixturePack(join(root, "packs", "note-mod"), "note-mod", { description: "TREE VERSION" })

		const { packs } = new PackRegistry(root).discover()
		const found = packs.find((m) => m.name === "note-mod")
		expect(found?.description).toBe("TREE VERSION")
	})
})

describe("PackRegistry.discover — user scope", () => {
	it("discovers packs from the user marketplace", () => {
		const root = makeTempDir("baka-disc-user-root-")
		const home = process.env.HOME as string
		writeFixturePack(join(home, ".baka", "packs", "user-mod"), "user-mod", { description: "user-scope pack" })

		const { packs } = new PackRegistry(root).discover()
		const found = packs.find((m) => m.name === "user-mod")
		expect(found?.description).toBe("user-scope pack")
	})
})

describe("PackRegistry.recipeIdCollisions", () => {
	it("reports recipe ids exported by two different packs, naming both", () => {
		const root = makeTempDir("baka-disc-collide-")
		writeFixturePack(join(root, "packs", "mod-a"), "mod-a", { recipeIds: ["collide", "unique-a"] })
		writeFixturePack(join(root, "packs", "mod-b"), "mod-b", { recipeIds: ["collide"] })

		const registry = new PackRegistry(root)
		const { packs } = registry.discover()
		// Discovery itself succeeds: both packs are listed.
		expect(packs.map((m) => m.name)).toEqual(["mod-a", "mod-b"])

		const collisions = registry.recipeIdCollisions()
		expect(collisions.get("collide")).toEqual(["mod-a", "mod-b"])
		expect(collisions.has("unique-a")).toBe(false)
	})

	it("does not flag a recipe id when the same pack owns it across scopes", () => {
		const root = makeTempDir("baka-disc-same-mod-")
		const home = process.env.HOME as string
		writeFixturePack(join(home, ".baka", "packs", "dup-mod"), "dup-mod", { recipeIds: ["act"] })
		writeFixturePack(join(root, ".baka", "packs", "dup-mod"), "dup-mod", { recipeIds: ["act"] })

		const registry = new PackRegistry(root)
		registry.discover()
		expect(registry.recipeIdCollisions().size).toBe(0)
	})
})
