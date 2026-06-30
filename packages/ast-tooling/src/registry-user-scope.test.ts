import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModuleRegistry } from "./registry.js"

// ---------------------------------------------------------------------------
// Battle-test: ModuleRegistry.discover() must find user-scope modules at
// the NEW marketplace path ~/.baka/modules/<name>/, not the retired
// ~/.local/share/baka/modules/ path.
//
// Commit 0b5331d migrated package-manager.ts userModulesDir() to
// ~/.baka/modules (where marketplace installs now land) but did NOT update
// registry.ts, which still searches ~/.local/share/baka/modules. So a
// module installed via `baka install --scope user` is never found by the
// validator/registry. This test fails for the RIGHT reason: the module is
// materialised at ~/.baka/modules but the registry looks elsewhere.
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

describe("ModuleRegistry user-scope path (battle)", () => {
	it("discovers a user-scope module installed at ~/.baka/modules/<name>/", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-reg-home-"))
		cleanup.push(fakeHome)
		process.env.HOME = fakeHome

		// An empty project cwd (no tree modules, no package.json so bundled
		// scope is skipped). The only module lives in the user scope.
		const projectCwd = mkdtempSync(join(tmpdir(), "baka-reg-cwd-"))
		cleanup.push(projectCwd)

		// Materialise a marketplace module at the NEW path ~/.baka/modules.
		const modDir = join(fakeHome, ".baka", "modules", "battle-user-mod")
		const actionDir = join(modDir, "act")
		mkdirSync(actionDir, { recursive: true })
		writeFileSync(
			join(modDir, "manifest.ts"),
			`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "battle-user-mod",
	version: "0.1.0",
	description: "battle user scope",
	dependencies: [],
	conflictsWith: [],
	actions: [{ id: "act", description: "Act", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
		)
		writeFileSync(join(actionDir, "action.ts"), "export const actAction = {}\n")

		// Do NOT create anything under ~/.local/share/baka (the stale path).

		const reg = new ModuleRegistry(projectCwd)
		const { modules } = reg.discover()

		// If registry read the correct user-scope path, the module is found.
		expect(modules.map((m) => m.name)).toContain("battle-user-mod")
	})
})
