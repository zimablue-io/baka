import { describe, expect, it } from "vitest"
import app from "../src/index"

describe("GET /v1/built-in", () => {
	it("returns the built-in catalog with tier attached", async () => {
		const res = await app.request("/v1/built-in")
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			name: string
			modules: Array<{ name: string; tier: string }>
		}
		expect(body.name).toBe("baka-built-in")
		expect(body.modules.length).toBeGreaterThan(0)
		for (const m of body.modules) {
			expect(m.tier).toBe("built-in")
		}
	})

	it("includes baka-base and ts-style", async () => {
		const res = await app.request("/v1/built-in")
		const body = (await res.json()) as { modules: Array<{ name: string }> }
		const names = body.modules.map((m) => m.name)
		expect(names).toContain("baka-base")
		expect(names).toContain("ts-style")
	})

	it("sets a 1h Cache-Control header", async () => {
		const res = await app.request("/v1/built-in")
		const cc = res.headers.get("cache-control")
		expect(cc).toMatch(/max-age=3600/)
	})
})

describe("GET /v1/built-in/:moduleName", () => {
	it("returns a single built-in module with tier", async () => {
		const res = await app.request("/v1/built-in/baka-base")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { name: string; tier: string; actions: unknown[] }
		expect(body.name).toBe("baka-base")
		expect(body.tier).toBe("built-in")
		expect(Array.isArray(body.actions)).toBe(true)
	})

	it("returns 404 for an unknown module", async () => {
		const res = await app.request("/v1/built-in/does-not-exist")
		expect(res.status).toBe(404)
	})

	it("returns 404 for a community module that is not built-in", async () => {
		const res = await app.request("/v1/built-in/community-foo")
		expect(res.status).toBe(404)
	})
})
