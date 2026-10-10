import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PackDirsError, packDirsFromSettings, resolvePackDirs } from "./pack-dirs.js"

const created: string[] = []
afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	created.push(dir)
	return dir
}

function writeSettings(root: string, body: unknown): string {
	mkdirSync(join(root, ".baka"), { recursive: true })
	const path = join(root, ".baka", "settings.json")
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body))
	return path
}

describe("packDirsFromSettings", () => {
	it("is undefined without a settings file, without the key, and for an empty list", () => {
		const root = tmp("baka-md-")
		expect(packDirsFromSettings(root)).toBeUndefined()
		writeSettings(root, { packages: [] })
		expect(packDirsFromSettings(root)).toBeUndefined()
		writeSettings(root, { packDirs: [] })
		expect(packDirsFromSettings(root)).toBeUndefined()
	})

	it("resolves relative entries against the project root, keeps absolute ones, and keeps the order", () => {
		const parent = tmp("baka-md-")
		const root = join(parent, "project")
		mkdirSync(join(parent, "catalog", "packs"), { recursive: true })
		mkdirSync(join(root, "local"), { recursive: true })
		const abs = tmp("baka-md-abs-")
		writeSettings(root, { packDirs: ["../catalog/packs", abs, "local"] })
		expect(packDirsFromSettings(root)).toEqual([join(parent, "catalog", "packs"), abs, join(root, "local")])
	})

	it("names the file, the entry and the fix when a listed directory does not exist", () => {
		const root = tmp("baka-md-")
		mkdirSync(join(root, "real"))
		const file = writeSettings(root, { packDirs: ["real", "../missing-catalog/packs"] })
		let caught: unknown
		try {
			packDirsFromSettings(root)
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(PackDirsError)
		const message = (caught as Error).message
		expect(message).toContain(file)
		expect(message).toContain("packDirs[1]")
		expect(message).toContain("../missing-catalog/packs")
		expect(message).toMatch(/create the directory|fix the entry|remove/i)
		expect(message).not.toContain("    at ")
	})

	it("rejects an entry that is a file, not a directory", () => {
		const root = tmp("baka-md-")
		writeFileSync(join(root, "afile"), "x")
		writeSettings(root, { packDirs: ["afile"] })
		expect(() => packDirsFromSettings(root)).toThrow(/packDirs\[0\].*not a directory/s)
	})

	it("rejects malformed JSON, a non-array value and non-string or empty entries, naming the file", () => {
		const root = tmp("baka-md-")
		const file = writeSettings(root, "{ not json")
		expect(() => packDirsFromSettings(root)).toThrow(file)
		expect(() => packDirsFromSettings(root)).toThrow(/not valid JSON/)
		writeSettings(root, { packDirs: "packs" })
		expect(() => packDirsFromSettings(root)).toThrow(/packDirs must be an array of directory paths/)
		writeSettings(root, { packDirs: ["ok", 3] })
		expect(() => packDirsFromSettings(root)).toThrow(/packDirs\[0\]|packDirs\[1\]/)
		writeSettings(root, { packDirs: [""] })
		expect(() => packDirsFromSettings(root)).toThrow(/packDirs\[0\].*non-empty string/s)
	})
})

describe("resolvePackDirs precedence", () => {
	it("is flag, then BAKA_PACK_DIRS, then settings, then undefined (default discovery)", () => {
		const root = tmp("baka-md-")
		const fromFlag = tmp("baka-md-flag-")
		const fromEnvA = tmp("baka-md-env-")
		const fromEnvB = tmp("baka-md-env-")
		mkdirSync(join(root, "settings-dir"))
		writeSettings(root, { packDirs: ["settings-dir"] })
		const env = { BAKA_PACK_DIRS: [fromEnvA, fromEnvB].join(delimiter) }

		expect(resolvePackDirs({ root, flag: [fromFlag], env })).toEqual([fromFlag])
		expect(resolvePackDirs({ root, flag: [], env })).toEqual([fromEnvA, fromEnvB])
		expect(resolvePackDirs({ root, env: {} })).toEqual([join(root, "settings-dir")])
		expect(resolvePackDirs({ root: tmp("baka-md-"), env: {} })).toBeUndefined()
	})

	it("does not read the settings file when a flag or the environment decides", () => {
		const root = tmp("baka-md-")
		const dir = tmp("baka-md-flag-")
		writeSettings(root, { packDirs: ["does-not-exist"] })
		expect(resolvePackDirs({ root, flag: [dir], env: {} })).toEqual([dir])
		expect(resolvePackDirs({ root, env: { BAKA_PACK_DIRS: dir } })).toEqual([dir])
		expect(() => resolvePackDirs({ root, env: {} })).toThrow(PackDirsError)
	})
})
