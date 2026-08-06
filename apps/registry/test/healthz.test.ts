import { describe, expect, it } from "vitest"
import app from "../src/index"

/**
 * Decision 10: `GET /healthz` returns `{"status":"ok"}` when the HTTP layer is up.
 * The endpoint must not depend on worker or DB state (those are covered by
 * milestone 3+).
 */

describe("GET /healthz", () => {
	it("returns 200 with status: ok", async () => {
		const res = await app.request("/healthz")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { status: string }
		expect(body).toEqual({ status: "ok" })
	})

	it("returns a JSON content-type header", async () => {
		const res = await app.request("/healthz")
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
	})

	it("does not require any credential", async () => {
		const res = await app.request("/healthz")
		expect(res.status).toBe(200)
	})
})
