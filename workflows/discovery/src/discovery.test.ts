import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mock homedir() so user-scope discovery is hermetic. vi.hoisted ensures
// the mutable ref is available when the hoisted vi.mock factory runs.
// ---------------------------------------------------------------------------

const mockHome = vi.hoisted(() => ({ dir: "" }))

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>()
	return {
		...actual,
		homedir: () => mockHome.dir,
	}
})

import { discoverModules } from "./discovery.js"

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanup: string[] = []

afterEach(() => {
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

beforeEach(() => {
	// Default: empty fake HOME so real user-scope modules never leak in.
	const dir = mkdtempSync(join(tmpdir(), "baka-disc-home-"))
	cleanup.push(dir)
	mockHome.dir = dir
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	cleanup.push(dir)
	return dir
}

function writeManifest(dir: string, moduleDirName: string, opts: { name?: string; description?: string } = {}): void {
	const moduleDir = join(dir, "modules", moduleDirName)
	mkdirSync(moduleDir, { recursive: true })
	const name = opts.name ?? moduleDirName
	const description = opts.description ?? "fake"
	writeFileSync(
		join(moduleDir, "manifest.ts"),
		`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "${name}",
	version: "0.1.0",
	description: "${description}",
	dependencies: [],
	conflictsWith: [],
	actions: [{ id: "act", description: "x", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
	)
}

function writePackageJson(dir: string): void {
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-project", version: "0.0.0" }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverModules — tree scope", () => {
	it("discovers modules from <rootDir>/modules/", () => {
		const root = makeTempDir("baka-disc-tree-")
		writeManifest(root, "fake-tree", { description: "tree-scope module" })
		const mods = discoverModules(root)
		const found = mods.find((m) => m.name === "fake-tree")
		expect(found, "fake-tree not discovered from tree scope").toBeDefined()
		expect(found?.description).toBe("tree-scope module")
	})
})

describe("discoverModules — bundled scope", () => {
	it("discovers baka repo bundled modules when rootDir has package.json but no modules/", () => {
		const root = makeTempDir("baka-disc-bundled-")
		writePackageJson(root)
		const mods = discoverModules(root)
		const names = mods.map((m) => m.name)
		expect(names).toContain("baka-base")
		expect(names).toContain("sdd")
		expect(names).toContain("ts-style")
	})
})

describe("discoverModules — dedup (tree wins)", () => {
	it("tree-scope baka-base wins over bundled baka-base", () => {
		const root = makeTempDir("baka-disc-dedup-")
		writeManifest(root, "baka-base", { name: "baka-base", description: "TREE VERSION" })
		writePackageJson(root)
		const mods = discoverModules(root)
		const found = mods.find((m) => m.name === "baka-base")
		expect(found, "baka-base not discovered").toBeDefined()
		expect(found?.description).toBe("TREE VERSION")
	})
})

describe("discoverModules — package.json gate", () => {
	it("empty dir (no package.json, no modules/) returns empty array", () => {
		const root = makeTempDir("baka-disc-empty-")
		const mods = discoverModules(root)
		expect(mods).toEqual([])
	})
})

describe("discoverModules — user scope", () => {
	it("discovers modules from ~/.baka/modules/", () => {
		// Override the default empty HOME with one that has a user-scope module.
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-disc-user-home-"))
		cleanup.push(fakeHome)
		mockHome.dir = fakeHome

		const userModDir = join(fakeHome, ".baka", "modules", "user-mod")
		mkdirSync(userModDir, { recursive: true })
		writeFileSync(
			join(userModDir, "manifest.ts"),
			`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "user-mod",
	version: "0.1.0",
	description: "user-scope module",
	dependencies: [],
	conflictsWith: [],
	actions: [{ id: "act", description: "x", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
		)

		// Root dir with no modules/ and no package.json — only user scope can find modules.
		const root = makeTempDir("baka-disc-user-root-")
		const mods = discoverModules(root)
		const found = mods.find((m) => m.name === "user-mod")
		expect(found, "user-mod not discovered from user scope").toBeDefined()
		expect(found?.description).toBe("user-scope module")
	})
})
