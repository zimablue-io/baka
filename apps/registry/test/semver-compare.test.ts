import { describe, expect, it } from "vitest"
import { compareSemver, maxSemver, sortSemverAsc } from "../src/semver-compare"

/**
 * Semver comparator (registry-read-paths feature).
 *
 * The latest-version pointer on the catalog list / detail endpoints
 * must follow SemVer 2.0.0 precedence rules — never insertion order
 * (architecture §8 decision 11). The publish endpoint already
 * validates tags against the strict semver grammar, so every
 * version in the database is well-formed; this suite pins the
 * comparator's behavior.
 */

describe("compareSemver", () => {
	describe("core numeric ordering", () => {
		it("returns -1 when a < b on major", () => {
			expect(compareSemver("1.0.0", "2.0.0")).toBe(-1)
		})
		it("returns -1 when a < b on minor", () => {
			expect(compareSemver("1.2.0", "1.3.0")).toBe(-1)
		})
		it("returns -1 when a < b on patch", () => {
			expect(compareSemver("1.2.3", "1.2.4")).toBe(-1)
		})
		it("returns +1 when a > b on major", () => {
			expect(compareSemver("10.0.0", "9.0.0")).toBe(1)
		})
		it("treats versions numerically, not lexicographically (10 > 9)", () => {
			expect(compareSemver("1.10.0", "1.9.0")).toBe(1)
			expect(compareSemver("1.9.0", "1.10.0")).toBe(-1)
			expect(compareSemver("2.0.0", "10.0.0")).toBe(-1)
		})
		it("returns 0 when versions are equal", () => {
			expect(compareSemver("1.2.3", "1.2.3")).toBe(0)
		})
	})

	describe("leading `v` is normalized", () => {
		it("v1.0.0 and 1.0.0 compare equal", () => {
			expect(compareSemver("v1.0.0", "1.0.0")).toBe(0)
		})
		it("v1.10.0 sorts after v1.9.0 (semver, not lexicographic)", () => {
			expect(compareSemver("v1.10.0", "v1.9.0")).toBe(1)
		})
		it("mixed v-prefix and bare forms sort correctly", () => {
			expect(compareSemver("v1.0.0", "0.9.0")).toBe(1)
		})
	})

	describe("pre-release ordering (spec rule)", () => {
		it("1.0.0-alpha < 1.0.0", () => {
			expect(compareSemver("1.0.0-alpha", "1.0.0")).toBe(-1)
		})
		it("1.0.0 < 1.0.0-alpha is FALSE", () => {
			expect(compareSemver("1.0.0", "1.0.0-alpha")).toBe(1)
		})
		it("1.0.0-alpha < 1.0.0-beta (alphanumeric lex)", () => {
			expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1)
		})
		it("1.0.0-alpha.1 < 1.0.0-alpha.2 (numeric)", () => {
			expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1)
		})
		it("numeric identifiers have lower precedence than alphanumeric at the same position", () => {
			expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1)
			expect(compareSemver("1.0.0-alpha", "1.0.0-1")).toBe(1)
		})
		it("a longer pre-release set has higher precedence when all preceding identifiers are equal", () => {
			expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1)
			expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1)
		})
		it("rc.1 < rc.10 (numeric identifiers compare numerically)", () => {
			expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.10")).toBe(-1)
		})
		it("pre-release on the higher-core version still loses when the lower core is bigger", () => {
			expect(compareSemver("2.0.0-alpha", "1.9.9")).toBe(1)
		})
	})

	describe("build metadata is ignored for ordering", () => {
		it("1.0.0+build.1 and 1.0.0+build.2 are equal", () => {
			expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0)
		})
		it("1.0.0+build and 1.0.0 are equal", () => {
			expect(compareSemver("1.0.0+build", "1.0.0")).toBe(0)
		})
		it("build metadata does not affect ordering relative to pre-release", () => {
			expect(compareSemver("1.0.0-rc.1+build.5", "1.0.0-rc.1+build.9")).toBe(0)
			expect(compareSemver("1.0.0-rc.1+build.5", "1.0.0")).toBe(-1)
		})
	})
})

describe("sortSemverAsc", () => {
	it("sorts a mix of versions into semver order (not lexicographic)", () => {
		const sorted = sortSemverAsc(["1.0.0", "1.10.0", "1.9.0", "1.2.0", "1.0.0-alpha"])
		expect(sorted).toEqual(["1.0.0-alpha", "1.0.0", "1.2.0", "1.9.0", "1.10.0"])
	})

	it("does not mutate the input", () => {
		const input = ["1.0.0", "1.10.0", "1.9.0"]
		const copy = [...input]
		sortSemverAsc(input)
		expect(input).toEqual(copy)
	})

	it("handles v-prefix forms", () => {
		expect(sortSemverAsc(["v2.0.0", "v1.0.0", "v1.10.0"])).toEqual(["v1.0.0", "v1.10.0", "v2.0.0"])
	})
})

describe("maxSemver", () => {
	it("returns the highest-precedence version from a list", () => {
		expect(maxSemver(["1.0.0", "1.10.0", "1.9.0"])).toBe("1.10.0")
	})

	it("returns null on empty input", () => {
		expect(maxSemver([])).toBeNull()
	})

	it("ignores insertion order (the inverse-order input still picks 1.10.0)", () => {
		expect(maxSemver(["1.10.0", "1.9.0", "1.0.0"])).toBe("1.10.0")
	})

	it("returns the only element for a single-item list", () => {
		expect(maxSemver(["v0.1.0"])).toBe("v0.1.0")
	})

	it("applies pre-release precedence", () => {
		expect(maxSemver(["1.0.0-rc.1", "1.0.0", "1.0.0-alpha"])).toBe("1.0.0")
	})
})
