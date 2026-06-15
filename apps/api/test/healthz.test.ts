import { describe, expect, it } from "vitest"
import app from "../src/index"

describe("healthz", () => {
	it("returns 200 with status: ok", async () => {
		const res = await app.request("/healthz")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { status: string }
		expect(body).toEqual({ status: "ok" })
	})

	it("sets a Content-Type of application/json", async () => {
		const res = await app.request("/healthz")
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
	})
})
