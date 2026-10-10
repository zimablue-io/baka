import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PackRegistry } from "./registry.js"

// ---------------------------------------------------------------------------
// Battle-test: PackRegistry.discover() must find user-scope packs at
// the NEW marketplace path ~/.baka/packs/<name>/, not the retired
// ~/.local/share/baka/packs/ path.
//
// Commit 0b5331d migrated package-manager.ts userPacksDir() to
// ~/.baka/packs (where marketplace installs now land) but did NOT update
// registry.ts, which still searches ~/.local/share/baka/packs. So a
// pack installed via `baka install --scope user` is never found by the
// validator/registry. This test fails for the RIGHT reason: the pack is
// materialised at ~/.baka/packs but the registry looks elsewhere.
// ---------------------------------------------------------------------------

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

describe("PackRegistry user-scope path (battle)", () => {
	it("discovers a user-scope pack installed at ~/.baka/packs/<name>/", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-reg-home-"))
		cleanup.push(fakeHome)
		process.env.HOME = fakeHome

		// An empty project cwd (no tree packs, no package.json so bundled
		// scope is skipped). The only pack lives in the user scope.
		const projectCwd = mkdtempSync(join(tmpdir(), "baka-reg-cwd-"))
		cleanup.push(projectCwd)

		// Materialise a marketplace pack at the NEW path ~/.baka/packs.
		const modDir = join(fakeHome, ".baka", "packs", "battle-user-mod")
		const recipeDir = join(modDir, "act")
		mkdirSync(recipeDir, { recursive: true })
		writeFileSync(
			join(modDir, "manifest.ts"),
			`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "battle-user-mod",
	version: "0.1.0",
	description: "battle user scope",
	dependencies: [],
	conflictsWith: [],
	recipes: [{ id: "act", description: "Act", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	packValidators: [],
}
`,
		)
		writeFileSync(join(recipeDir, "recipe.ts"), "export const actRecipe = {}\n")

		// Do NOT create anything under ~/.local/share/baka (the stale path).

		const reg = new PackRegistry(projectCwd)
		const { packs } = reg.discover()

		// If registry read the correct user-scope path, the pack is found.
		expect(packs.map((m) => m.name)).toContain("battle-user-mod")
	})
})
