import { describe, expect, it } from "vitest"
import app from "../src/index"

describe("GET /v1/verified", () => {
	it("returns 200 with a catalogs array", async () => {
		const res = await app.request("/v1/verified")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { catalogs: unknown[] }
		expect(Array.isArray(body.catalogs)).toBe(true)
	})

	it("sets a 1h Cache-Control header", async () => {
		const res = await app.request("/v1/verified")
		const cc = res.headers.get("cache-control")
		expect(cc).toMatch(/max-age=3600/)
	})
})
