import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRegistry, describeModules, ModuleDirsError, resolveModuleDirs } from "../src/index.js"
import { cleanupTempDirs, tempDir, writeModule } from "./helpers.js"

afterEach(cleanupTempDirs)

describe("module directories from the project's settings", () => {
	it("lets an embedder read the project's moduleDirs and build a catalog from them", () => {
		const parent = tempDir()
		const project = join(parent, "project")
		mkdirSync(join(project, ".baka"), { recursive: true })
		writeModule(join(parent, "catalog"), {
			name: "widget",
			actions: [{ id: "make", templates: { "w.txt.hbs": "w\n" } }],
		})
		writeFileSync(join(project, ".baka", "settings.json"), JSON.stringify({ moduleDirs: ["../catalog"] }))

		const moduleDirs = resolveModuleDirs({ root: project, env: {} })
		expect(moduleDirs).toEqual([join(parent, "catalog")])
		const catalog = describeModules(createRegistry({ root: project, moduleDirs: moduleDirs ?? [] }))
		expect(catalog.modules.map((m) => m.name)).toEqual(["widget"])
	})

	it("throws ModuleDirsError for a listed directory that does not exist", () => {
		const project = tempDir()
		mkdirSync(join(project, ".baka"))
		writeFileSync(join(project, ".baka", "settings.json"), JSON.stringify({ moduleDirs: ["nowhere"] }))
		expect(() => resolveModuleDirs({ root: project, env: {} })).toThrow(ModuleDirsError)
	})
})
