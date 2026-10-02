import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModuleDirsError, moduleDirsFromSettings, resolveModuleDirs } from "./module-dirs.js"

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

describe("moduleDirsFromSettings", () => {
	it("is undefined without a settings file, without the key, and for an empty list", () => {
		const root = tmp("baka-md-")
		expect(moduleDirsFromSettings(root)).toBeUndefined()
		writeSettings(root, { packages: [] })
		expect(moduleDirsFromSettings(root)).toBeUndefined()
		writeSettings(root, { moduleDirs: [] })
		expect(moduleDirsFromSettings(root)).toBeUndefined()
	})

	it("resolves relative entries against the project root, keeps absolute ones, and keeps the order", () => {
		const parent = tmp("baka-md-")
		const root = join(parent, "project")
		mkdirSync(join(parent, "catalog", "modules"), { recursive: true })
		mkdirSync(join(root, "local"), { recursive: true })
		const abs = tmp("baka-md-abs-")
		writeSettings(root, { moduleDirs: ["../catalog/modules", abs, "local"] })
		expect(moduleDirsFromSettings(root)).toEqual([join(parent, "catalog", "modules"), abs, join(root, "local")])
	})

	it("names the file, the entry and the fix when a listed directory does not exist", () => {
		const root = tmp("baka-md-")
		mkdirSync(join(root, "real"))
		const file = writeSettings(root, { moduleDirs: ["real", "../missing-catalog/modules"] })
		let caught: unknown
		try {
			moduleDirsFromSettings(root)
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(ModuleDirsError)
		const message = (caught as Error).message
		expect(message).toContain(file)
		expect(message).toContain("moduleDirs[1]")
		expect(message).toContain("../missing-catalog/modules")
		expect(message).toMatch(/create the directory|fix the entry|remove/i)
		expect(message).not.toContain("    at ")
	})

	it("rejects an entry that is a file, not a directory", () => {
		const root = tmp("baka-md-")
		writeFileSync(join(root, "afile"), "x")
		writeSettings(root, { moduleDirs: ["afile"] })
		expect(() => moduleDirsFromSettings(root)).toThrow(/moduleDirs\[0\].*not a directory/s)
	})

	it("rejects malformed JSON, a non-array value and non-string or empty entries, naming the file", () => {
		const root = tmp("baka-md-")
		const file = writeSettings(root, "{ not json")
		expect(() => moduleDirsFromSettings(root)).toThrow(file)
		expect(() => moduleDirsFromSettings(root)).toThrow(/not valid JSON/)
		writeSettings(root, { moduleDirs: "modules" })
		expect(() => moduleDirsFromSettings(root)).toThrow(/moduleDirs must be an array of directory paths/)
		writeSettings(root, { moduleDirs: ["ok", 3] })
		expect(() => moduleDirsFromSettings(root)).toThrow(/moduleDirs\[0\]|moduleDirs\[1\]/)
		writeSettings(root, { moduleDirs: [""] })
		expect(() => moduleDirsFromSettings(root)).toThrow(/moduleDirs\[0\].*non-empty string/s)
	})
})

describe("resolveModuleDirs precedence", () => {
	it("is flag, then BAKA_MODULE_DIRS, then settings, then undefined (default discovery)", () => {
		const root = tmp("baka-md-")
		const fromFlag = tmp("baka-md-flag-")
		const fromEnvA = tmp("baka-md-env-")
		const fromEnvB = tmp("baka-md-env-")
		mkdirSync(join(root, "settings-dir"))
		writeSettings(root, { moduleDirs: ["settings-dir"] })
		const env = { BAKA_MODULE_DIRS: [fromEnvA, fromEnvB].join(delimiter) }

		expect(resolveModuleDirs({ root, flag: [fromFlag], env })).toEqual([fromFlag])
		expect(resolveModuleDirs({ root, flag: [], env })).toEqual([fromEnvA, fromEnvB])
		expect(resolveModuleDirs({ root, env: {} })).toEqual([join(root, "settings-dir")])
		expect(resolveModuleDirs({ root: tmp("baka-md-"), env: {} })).toBeUndefined()
	})

	it("does not read the settings file when a flag or the environment decides", () => {
		const root = tmp("baka-md-")
		const dir = tmp("baka-md-flag-")
		writeSettings(root, { moduleDirs: ["does-not-exist"] })
		expect(resolveModuleDirs({ root, flag: [dir], env: {} })).toEqual([dir])
		expect(resolveModuleDirs({ root, env: { BAKA_MODULE_DIRS: dir } })).toEqual([dir])
		expect(() => resolveModuleDirs({ root, env: {} })).toThrow(ModuleDirsError)
	})
})
