import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { projectSettingsPath, readProjectSettings, removeSource } from "./package-manager.js"

const created: string[] = []
afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(settings: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-pm-settings-"))
	created.push(dir)
	mkdirSync(join(dir, ".baka"))
	writeFileSync(projectSettingsPath(dir), JSON.stringify(settings))
	return dir
}

describe("project settings keep the keys the package manager does not own", () => {
	it("reads a file without `packages` as an empty list and keeps the other keys", () => {
		const dir = project({ packDirs: ["../catalog"], registries: ["http://localhost:1"] })
		expect(readProjectSettings(dir)).toEqual({
			packages: [],
			packDirs: ["../catalog"],
			registries: ["http://localhost:1"],
		})
	})

	it("rewrites the file on removeSource without dropping packDirs or registries", () => {
		const dir = project({ packages: ["./a"], packDirs: ["../catalog"], registries: ["http://localhost:1"] })
		const { removed } = removeSource("./a", {
			settingsPath: projectSettingsPath(dir),
			packsDir: join(dir, ".baka", "packs"),
		})
		expect(removed).toBe(true)
		expect(JSON.parse(readFileSync(projectSettingsPath(dir), "utf-8"))).toEqual({
			packages: [],
			packDirs: ["../catalog"],
			registries: ["http://localhost:1"],
		})
	})
})
