// Decision 33 adoption tests: every user-level resolution site in
// ast-tooling honors BAKA_HOME over $HOME/.baka.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { userPacksDir, userSettingsPath } from "./package-manager.js"
import { PackRegistry } from "./registry.js"
import { StructuredLog } from "./structured-log.js"

const prevBakaHome = process.env.BAKA_HOME
const prevHome = process.env.HOME
const tempDirs: string[] = []

afterEach(() => {
	if (prevBakaHome === undefined) delete process.env.BAKA_HOME
	else process.env.BAKA_HOME = prevBakaHome
	if (prevHome === undefined) delete process.env.HOME
	else process.env.HOME = prevHome
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function mkTemp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix))
	tempDirs.push(d)
	return d
}

function setHomes(): { bakaHome: string; home: string } {
	const bakaHome = mkTemp("baka-home-adopt-")
	const home = mkTemp("baka-home-adopt-home-")
	process.env.BAKA_HOME = bakaHome
	process.env.HOME = home
	return { bakaHome, home }
}

describe("BAKA_HOME adoption (architecture decision 33)", () => {
	it("userSettingsPath and userPacksDir resolve under BAKA_HOME", () => {
		const { bakaHome } = setHomes()
		expect(userSettingsPath()).toBe(join(bakaHome, "settings.json"))
		expect(userPacksDir()).toBe(join(bakaHome, "packs"))
	})

	it("StructuredLog writes under BAKA_HOME/logs", () => {
		const { bakaHome } = setHomes()
		const log = new StructuredLog("test-run")
		const file = log.resolve()
		expect(file.startsWith(join(bakaHome, "logs"))).toBe(true)
	})

	it("PackRegistry discovers user-scope packs under BAKA_HOME/packs", () => {
		const { bakaHome } = setHomes()
		const root = mkTemp("baka-home-adopt-root-")
		const modDir = join(bakaHome, "packs", "baka-home-mod")
		mkdirSync(modDir, { recursive: true })
		writeFileSync(
			join(modDir, "manifest.ts"),
			`export const Manifest = {
				name: "baka-home-mod",
				version: "0.1.0",
				description: "user scope via BAKA_HOME",
				recipes: [{ id: "act", description: "act", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
				dependencies: [],
				conflictsWith: [],
				packValidators: [],
			}`,
		)
		mkdirSync(join(modDir, "act"), { recursive: true })
		writeFileSync(join(modDir, "act", "recipe.ts"), "export const actRecipe = {}\n")

		const registry = new PackRegistry(root)
		const { packs, diagnostics } = registry.discover(false)
		expect(
			packs.map((m: { name: string }) => m.name),
			`diagnostics=${JSON.stringify(diagnostics)}`,
		).toContain("baka-home-mod")
	})
})
