import { describe, expect, it } from "vitest"
import { matchGlobs } from "./glob.js"

const PATHS = [
	"package.json",
	"packages/ui/package.json",
	"packages/ui/src/index.ts",
	"packages/ui/deep/package.json",
	"apps/web/src/main.tsx",
	"apps/web/package.json",
	"a.b",
]

describe("matchGlobs", () => {
	it("matches a literal path exactly", () => {
		expect(matchGlobs(PATHS, ["package.json"])).toEqual(["package.json"])
	})

	it("* stays within one segment", () => {
		expect(matchGlobs(PATHS, ["packages/*/package.json"])).toEqual(["packages/ui/package.json"])
		expect(matchGlobs(PATHS, ["*.json"])).toEqual(["package.json"])
	})

	it("** crosses segments, and `a/**/b` also matches a/b", () => {
		expect(matchGlobs(PATHS, ["packages/**/package.json"])).toEqual([
			"packages/ui/package.json",
			"packages/ui/deep/package.json",
		])
		expect(matchGlobs(["a/b", "a/x/b", "a/x/y/b", "ab"], ["a/**/b"])).toEqual(["a/b", "a/x/b", "a/x/y/b"])
		expect(matchGlobs(PATHS, ["apps/**"])).toEqual(["apps/web/src/main.tsx", "apps/web/package.json"])
	})

	it("? matches one character and regex metacharacters are literal", () => {
		expect(matchGlobs(PATHS, ["a?b"])).toEqual(["a.b"])
		expect(matchGlobs(["a.b", "axb"], ["a.b"])).toEqual(["a.b"])
	})

	it("matches any of several patterns and none for an empty list", () => {
		expect(matchGlobs(PATHS, ["package.json", "apps/web/package.json"])).toEqual([
			"package.json",
			"apps/web/package.json",
		])
		expect(matchGlobs(PATHS, [])).toEqual([])
	})
})
