import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PackRegistry } from "./registry.js"

const cleanup: string[] = []
const prevHome = process.env.HOME

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
	const dir = mkdtempSync(join(tmpdir(), "baka-registry-home-"))
	cleanup.push(dir)
	process.env.HOME = dir
})

function makeProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-registry-"))
	cleanup.push(dir)
	mkdirSync(join(dir, "packs", "mod-a"), { recursive: true })
	mkdirSync(join(dir, "packs", "mod-b"), { recursive: true })
	mkdirSync(join(dir, "packs", "mod-a", "do-thing"), { recursive: true })
	mkdirSync(join(dir, "packs", "mod-b", "act"), { recursive: true })
	writeFileSync(
		join(dir, "packs", "mod-a", "manifest.ts"),
		`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "mod-a",
	version: "0.1.0",
	description: "A",
	dependencies: [],
	conflictsWith: [],
	recipes: [{ id: "do-thing", description: "Do the thing", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	packValidators: [],
}
`,
	)
	writeFileSync(
		join(dir, "packs", "mod-b", "manifest.ts"),
		`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "mod-b",
	version: "0.1.0",
	description: "B",
	dependencies: ["mod-a"],
	conflictsWith: [],
	recipes: [{ id: "act", description: "Act", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	packValidators: [],
}
`,
	)
	writeFileSync(join(dir, "packs", "mod-a", "do-thing", "recipe.ts"), "export const doThingRecipe = {}\n")
	writeFileSync(join(dir, "packs", "mod-b", "act", "recipe.ts"), "export const actRecipe = {}\n")
	return dir
}

describe("PackRegistry", () => {
	it("discovers valid packs", () => {
		const dir = makeProject()
		const reg = new PackRegistry(dir)
		const { packs, diagnostics } = reg.discover()
		expect(packs).toHaveLength(2)
		expect(diagnostics.filter((d) => d.severity === "error")).toEqual([])
	})

	it("flags missing recipe.ts as an error", () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-registry-"))
		cleanup.push(dir)
		mkdirSync(join(dir, "packs", "broken"), { recursive: true })
		mkdirSync(join(dir, "packs", "broken", "do-thing"), { recursive: true })
		writeFileSync(
			join(dir, "packs", "broken", "manifest.ts"),
			`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "broken", version: "0.1.0", description: "", dependencies: [], conflictsWith: [],
	recipes: [{ id: "do-thing", description: "X", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	packValidators: [],
}
`,
		)
		const reg = new PackRegistry(dir)
		const { diagnostics } = reg.discover()
		expect(diagnostics.some((d) => d.severity === "error" && d.rule === "recipe-missing")).toBe(true)
	})

	it("returns packs in dependency order", () => {
		const dir = makeProject()
		const reg = new PackRegistry(dir)
		reg.discover()
		const order = reg.resolveOrder().map((m) => m.name)
		expect(order.indexOf("mod-a")).toBeLessThan(order.indexOf("mod-b"))
	})

	it("resolvePackRoot prefers the project marketplace over the tree scope", () => {
		const dir = makeProject()
		const savedHome = process.env.HOME
		process.env.HOME = dir
		try {
			mkdirSync(join(dir, ".baka", "packs", "mod-a"), { recursive: true })
			writeFileSync(join(dir, ".baka", "packs", "mod-a", "manifest.ts"), `export const Manifest = { name: "mod-a" }\n`)
			const reg = new PackRegistry(dir)
			expect(reg.resolvePackRoot("mod-a")).toBe(join(dir, ".baka", "packs", "mod-a"))
		} finally {
			process.env.HOME = savedHome
		}
	})

	it("resolvePackRoot falls back to the tree scope and returns undefined when absent", () => {
		const dir = makeProject()
		const savedHome = process.env.HOME
		process.env.HOME = dir
		try {
			const reg = new PackRegistry(dir)
			expect(reg.resolvePackRoot("mod-a")).toBe(join(dir, "packs", "mod-a"))
			expect(reg.resolvePackRoot("ghost-mod")).toBeUndefined()
		} finally {
			process.env.HOME = savedHome
		}
	})

	it("throws on missing dependency", () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-registry-"))
		cleanup.push(dir)
		mkdirSync(join(dir, "packs", "lone"), { recursive: true })
		mkdirSync(join(dir, "packs", "lone", "act"), { recursive: true })
		writeFileSync(
			join(dir, "packs", "lone", "manifest.ts"),
			`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "lone", version: "0.1.0", description: "", dependencies: ["ghost"], conflictsWith: [],
	recipes: [{ id: "act", description: "X", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	packValidators: [],
}
`,
		)
		writeFileSync(join(dir, "packs", "lone", "act", "recipe.ts"), "export const actRecipe = {}\n")
		const reg = new PackRegistry(dir)
		reg.discover()
		expect(() => reg.resolveOrder()).toThrow(/ghost/)
	})
})
