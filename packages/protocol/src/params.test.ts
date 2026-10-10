import { describe, expect, it } from "vitest"
import { normalizeParams } from "./params"
import type { PackRecipeParam, ParamFormat } from "./schemas"

const SPECS: PackRecipeParam[] = [
	{ name: "name", type: "string", required: true, description: "who" },
	{ name: "count", type: "number", required: false, description: "how many" },
	{ name: "loud", type: "boolean", required: false, description: "shout", default: false },
	{
		name: "owner",
		type: "object",
		required: false,
		description: "owner",
		properties: [{ name: "age", type: "number", required: true, description: "age" }],
	},
]

describe("normalizeParams", () => {
	it("applies defaults and keeps typed values", () => {
		expect(normalizeParams(SPECS, { name: "Ada", count: 3 })).toEqual({
			ok: true,
			params: { name: "Ada", count: 3, loud: false },
		})
	})

	it("coerces text flags: numeric strings, true/false, and nested objects", () => {
		expect(normalizeParams(SPECS, { name: "Ada", count: "3", loud: "true", owner: { age: "41" } })).toEqual({
			ok: true,
			params: { name: "Ada", count: 3, loud: true, owner: { age: 41 } },
		})
	})

	it("does not coerce a string into a string param or a non-numeric string into a number", () => {
		const bad = normalizeParams(SPECS, { name: "Ada", count: "many" })
		expect(bad.ok).toBe(false)
		expect(bad.ok === false && bad.message).toContain("count")
	})

	it("rejects a missing required param and an undeclared param, naming each path", () => {
		const result = normalizeParams(SPECS, { typo: 1 })
		expect(result.ok).toBe(false)
		const message = result.ok === false ? result.message : ""
		expect(message).toContain("name")
		expect(message).toContain("typo")
	})

	it("names the nested path of a bad nested value", () => {
		const result = normalizeParams(SPECS, { name: "Ada", owner: { age: "old" } })
		expect(result.ok === false && result.message).toContain("owner.age")
	})
})

describe("string constraints", () => {
	const spec = (extra: Partial<PackRecipeParam>): PackRecipeParam[] => [
		{ name: "value", type: "string", required: true, description: "v", ...extra },
	]
	const accepts = (extra: Partial<PackRecipeParam>, value: string) =>
		normalizeParams(spec(extra), { value }).ok === true

	it("pattern is unanchored unless the author anchors it, like JSON Schema", () => {
		expect(accepts({ pattern: "^v\\d+$" }, "v12")).toBe(true)
		expect(accepts({ pattern: "^v\\d+$" }, "v12x")).toBe(false)
		expect(accepts({ pattern: "\\d" }, "abc1")).toBe(true)
	})

	it("minLength and maxLength bound the string", () => {
		expect(accepts({ minLength: 2, maxLength: 3 }, "a")).toBe(false)
		expect(accepts({ minLength: 2, maxLength: 3 }, "ab")).toBe(true)
		expect(accepts({ minLength: 2, maxLength: 3 }, "abcd")).toBe(false)
	})

	it("names the offending param and the constraint in the message", () => {
		const result = normalizeParams(spec({ format: "slug" }), { value: "Not A Slug" })
		expect(result.ok).toBe(false)
		expect(result.ok === false && result.message).toMatch(/value: .*slug/)
	})

	const FORMAT_CASES: Array<[ParamFormat, string[], string[]]> = [
		["slug", ["a", "my-app", "a1-b2"], ["", "My", "a--b", "-a", "a-", "a_b", "../x"]],
		["path-segment", ["x", "my.pkg", ".hidden", "..."], ["", ".", "..", "a/b", "a\\b", "a\nb", "a\u0000b"]],
		["relative-path", ["x", "a/b", "packages/ui", "a/..b"], ["", "/abs", "..", "../x", "a/../b", "a/..", "a\\b"]],
		["identifier", ["a", "_a1", "$x"], ["", "1a", "a-b", "a b"]],
		["package-name", ["pkg", "@scope/pkg", "my-pkg.js"], ["", "Pkg", "@scope", "@/pkg", "a b"]],
	]
	for (const [format, good, bad] of FORMAT_CASES) {
		it(`format ${format}`, () => {
			for (const v of good) expect(accepts({ format }, v), `accepts ${JSON.stringify(v)}`).toBe(true)
			for (const v of bad) expect(accepts({ format }, v), `rejects ${JSON.stringify(v)}`).toBe(false)
		})
	}

	it("applies to array items and nested object fields", () => {
		const specs: PackRecipeParam[] = [
			{
				name: "names",
				type: "array",
				required: true,
				description: "n",
				items: { type: "string", format: "slug" },
			},
			{
				name: "owner",
				type: "object",
				required: false,
				description: "o",
				properties: [{ name: "id", type: "string", required: true, description: "i", maxLength: 3 }],
			},
		]
		expect(normalizeParams(specs, { names: ["a", "b-c"] }).ok).toBe(true)
		expect(normalizeParams(specs, { names: ["a", "B"] }).ok).toBe(false)
		expect(normalizeParams(specs, { names: [], owner: { id: "abcd" } }).ok).toBe(false)
	})
})
