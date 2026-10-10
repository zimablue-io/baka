import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ensureDirectory, normalizeRelativePath, removeCreatedDirectories, resolveContained } from "./contain.js"
import { RecipeError } from "./errors.js"
import { revertFiles } from "./materialize.js"

const cleanup: string[] = []
afterEach(() => {
	for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-contain-"))
	cleanup.push(dir)
	return dir
}

function escapeCode(fn: () => unknown): string | undefined {
	try {
		fn()
	} catch (err) {
		return err instanceof RecipeError ? err.code : "other"
	}
	return undefined
}

describe("normalizeRelativePath", () => {
	it("normalizes dots and doubled slashes", () => {
		expect(normalizeRelativePath("./a//b/./c.txt")).toBe("a/b/c.txt")
	})

	it.each([
		["", "empty"],
		["/etc/passwd", "absolute"],
		["C:\\Windows", "drive letter"],
		["C:foo", "drive letter without separator"],
		["../x", "leading .."],
		["a/../../x", "escaping .."],
		["a/../b", "any .. segment"],
		["a\\b", "backslash"],
		["a\u0000b", "NUL"],
		["a\nb", "newline"],
		[".", "the root itself"],
		["./", "the root itself"],
		[".git/hooks/pre-commit", ".git"],
		["pkg/.git/config", "nested .git"],
		[".baka/packs/evil/manifest.ts", ".baka at the root"],
	])("rejects %j (%s)", (path) => {
		expect(escapeCode(() => normalizeRelativePath(path))).toBe("path-escape")
	})

	it("allows names that merely look similar", () => {
		expect(normalizeRelativePath(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml")
		expect(normalizeRelativePath(".gitignore")).toBe(".gitignore")
		expect(normalizeRelativePath("a/..b")).toBe("a/..b")
		expect(normalizeRelativePath("a/.baka")).toBe("a/.baka")
	})
})

describe("resolveContained", () => {
	it("returns the absolute path of a contained target, existing or not", () => {
		const root = scratch()
		expect(resolveContained(root, "a/b.txt")).toBe(join(root, "a", "b.txt"))
	})

	it("accepts a root that does not exist yet", () => {
		const root = join(scratch(), "fresh")
		expect(resolveContained(root, "a.txt")).toBe(join(root, "a.txt"))
	})

	it("rejects a path that goes through a symlinked directory pointing outside", () => {
		const root = scratch()
		const outside = scratch()
		symlinkSync(outside, join(root, "link"))
		expect(escapeCode(() => resolveContained(root, "link/x.txt"))).toBe("path-escape")
		expect(escapeCode(() => resolveContained(root, "link/deeper/x.txt"))).toBe("path-escape")
	})

	it("rejects a target that is itself a symlink, dangling or not", () => {
		const root = scratch()
		const outside = scratch()
		writeFileSync(join(outside, "secret"), "x")
		symlinkSync(join(outside, "secret"), join(root, "leak.txt"))
		symlinkSync(join(outside, "nowhere"), join(root, "dangling.txt"))
		expect(escapeCode(() => resolveContained(root, "leak.txt"))).toBe("path-escape")
		expect(escapeCode(() => resolveContained(root, "dangling.txt"))).toBe("path-escape")
	})

	it("allows a root that is itself reached through a symlink", () => {
		const real = scratch()
		const holder = scratch()
		const viaLink = join(holder, "project")
		symlinkSync(real, viaLink)
		expect(resolveContained(viaLink, "a/b.txt")).toBe(join(viaLink, "a", "b.txt"))
	})
})

describe("directories the run created", () => {
	it("records only the directories that did not exist and removes them, deepest first, when empty", () => {
		const root = scratch()
		mkdirSync(join(root, "keep"))
		const created: string[] = []
		ensureDirectory(root, "keep/new/deeper", created)
		expect(created).toEqual(["keep/new", "keep/new/deeper"])
		removeCreatedDirectories(root, created)
		expect(readdirSync(root)).toEqual(["keep"])
		expect(readdirSync(join(root, "keep"))).toEqual([])
	})

	it("leaves a created directory in place when something else now lives in it", () => {
		const root = scratch()
		const created: string[] = []
		ensureDirectory(root, "a/b", created)
		writeFileSync(join(root, "a", "b", "mine.txt"), "x")
		removeCreatedDirectories(root, created)
		expect(existsSync(join(root, "a", "b", "mine.txt"))).toBe(true)
	})
})

describe("revertFiles refuses a compensation that points outside the root", () => {
	it("rejects an escaping created path before deleting anything", () => {
		const root = scratch()
		const outside = scratch()
		writeFileSync(join(outside, "victim.txt"), "keep me")
		writeFileSync(join(root, "mine.txt"), "x")
		const relVictim = `../${outside.split("/").pop()}/victim.txt`
		expect(() =>
			revertFiles(root, { created: ["mine.txt", relVictim], createdDirs: [], overwritten: [] }),
		).toThrowError(/path-escape|\.\./)
		expect(existsSync(join(outside, "victim.txt"))).toBe(true)
		expect(existsSync(join(root, "mine.txt"))).toBe(true)
	})

	it("rejects an escaping overwritten path and an escaping createdDirs entry", () => {
		const root = scratch()
		expect(() =>
			revertFiles(root, {
				created: [],
				createdDirs: [],
				overwritten: [{ path: "../evil.txt", contentBase64: Buffer.from("x").toString("base64") }],
			}),
		).toThrow()
		expect(() => revertFiles(root, { created: [], createdDirs: ["../dir"], overwritten: [] })).toThrow()
		expect(() => revertFiles(root, { created: ["/etc/hosts"], createdDirs: [], overwritten: [] })).toThrow()
	})
})
