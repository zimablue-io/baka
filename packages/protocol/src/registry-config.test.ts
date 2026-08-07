import { describe, expect, it } from "vitest"
import { normalizeRegistryUrl, RegistryConfigMapSchema, RegistryCredentialSchema } from "./registry-config"

describe("normalizeRegistryUrl", () => {
	it("drops trailing slashes from the path", () => {
		expect(normalizeRegistryUrl("http://localhost:4300/")).toBe("http://localhost:4300")
		expect(normalizeRegistryUrl("http://localhost:4300/base/")).toBe("http://localhost:4300/base")
	})

	it("lowercases the scheme and host", () => {
		expect(normalizeRegistryUrl("HTTP://Localhost:4300")).toBe("http://localhost:4300")
		expect(normalizeRegistryUrl("HTTPS://Example.COM")).toBe("https://example.com")
	})

	it("preserves the path verbatim (no trailing slash)", () => {
		expect(normalizeRegistryUrl("http://localhost:4300/base")).toBe("http://localhost:4300/base")
	})

	it("preserves the path verbatim (no trailing slash)", () => {
		expect(normalizeRegistryUrl("http://localhost:4300/base")).toBe("http://localhost:4300/base")
	})

	it("drops query params (registry aliasing uses these in the URL only at hand-off; storage key is scheme+host)", () => {
		expect(normalizeRegistryUrl("http://localhost:4300?alias=alpha")).toBe("http://localhost:4300")
	})

	it("throws on empty or unparseable input", () => {
		expect(() => normalizeRegistryUrl("")).toThrow(/empty/)
		expect(() => normalizeRegistryUrl("not a url")).toThrow(/invalid/)
	})
})

describe("RegistryCredentialSchema", () => {
	it("accepts a non-empty apiKey", () => {
		const parsed = RegistryCredentialSchema.safeParse({ apiKey: "abc" })
		expect(parsed.success).toBe(true)
	})

	it("rejects an empty apiKey", () => {
		const parsed = RegistryCredentialSchema.safeParse({ apiKey: "" })
		expect(parsed.success).toBe(false)
	})

	it("rejects a missing apiKey", () => {
		const parsed = RegistryCredentialSchema.safeParse({})
		expect(parsed.success).toBe(false)
	})
})

describe("RegistryConfigMapSchema", () => {
	it("accepts a map of registry URLs to credentials", () => {
		const parsed = RegistryConfigMapSchema.safeParse({
			"http://localhost:4300": { apiKey: "alpha" },
			"http://localhost:4310": { apiKey: "beta" },
		})
		expect(parsed.success).toBe(true)
	})

	it("rejects a malformed credential inside the map", () => {
		const parsed = RegistryConfigMapSchema.safeParse({
			"http://localhost:4300": { apiKey: "" },
		})
		expect(parsed.success).toBe(false)
	})
})
