import { describe, expect, it } from "vitest"
import { normalizeParams } from "./params"
import type { ModuleActionParam } from "./schemas"

const SPECS: ModuleActionParam[] = [
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
