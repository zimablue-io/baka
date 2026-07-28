import { VerifiedResponseSchema } from "@repo/protocol"
import { describe, expect, it } from "vitest"
import verifiedData from "../src/data/verified.json"

/**
 * These tests exist so that any PR that breaks a data file fails CI.
 * The `load-data.ts` runtime also validates on import (defense in depth),
 * but the data-file schema is small and explicit enough to be its own
 * test target. The built-in catalog has no data file here: it lives in
 * `@repo/protocol` and is validated there.
 */

describe("data files", () => {
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
