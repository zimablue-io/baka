import { describe, expect, it } from "vitest"
import builtInData from "../src/data/built-in.json"
import verifiedData from "../src/data/verified.json"
import { CatalogSchema, VerifiedResponseSchema } from "../src/lib/schema"

/**
 * These tests exist so that any PR that breaks a data file fails CI.
 * The `load-data.ts` runtime also validates on import (defense in depth),
 * but the data-file schema is small and explicit enough to be its own
 * test target.
 */

describe("data files", () => {
	it("built-in.json is a valid catalog", () => {
		const result = CatalogSchema.safeParse(builtInData)
		if (!result.success) {
			throw new Error(
				`built-in.json failed validation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
			)
		}
		expect(result.success).toBe(true)
	})

	it("every built-in module has a name, version, and at least one action", () => {
		const result = CatalogSchema.parse(builtInData)
		for (const m of result.modules) {
			expect(m.name).toBeTruthy()
			expect(m.version).toBeTruthy()
			expect(m.actions.length).toBeGreaterThan(0)
		}
	})

	it("verified.json is a valid verified list", () => {
		const result = VerifiedResponseSchema.safeParse(verifiedData)
		if (!result.success) {
			throw new Error(
				`verified.json failed validation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
			)
		}
		expect(result.success).toBe(true)
	})
})
