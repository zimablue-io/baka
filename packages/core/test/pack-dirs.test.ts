import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRegistry, describePacks, PackDirsError, resolvePackDirs } from "../src/index.js"
import { cleanupTempDirs, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

describe("pack directories from the project's settings", () => {
	it("lets an embedder read the project's packDirs and build a catalog from them", () => {
		const parent = tempDir()
		const project = join(parent, "project")
		mkdirSync(join(project, ".baka"), { recursive: true })
		writePack(join(parent, "catalog"), {
			name: "widget",
			recipes: [{ id: "make", templates: { "w.txt.hbs": "w\n" } }],
		})
		writeFileSync(join(project, ".baka", "settings.json"), JSON.stringify({ packDirs: ["../catalog"] }))

		const packDirs = resolvePackDirs({ root: project, env: {} })
		expect(packDirs).toEqual([join(parent, "catalog")])
		const catalog = describePacks(createRegistry({ root: project, packDirs: packDirs ?? [] }))
		expect(catalog.packs.map((m) => m.name)).toEqual(["widget"])
	})

	it("throws PackDirsError for a listed directory that does not exist", () => {
		const project = tempDir()
		mkdirSync(join(project, ".baka"))
		writeFileSync(join(project, ".baka", "settings.json"), JSON.stringify({ packDirs: ["nowhere"] }))
		expect(() => resolvePackDirs({ root: project, env: {} })).toThrow(PackDirsError)
	})
})
