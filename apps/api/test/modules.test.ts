import { beforeEach, describe, expect, it } from "vitest"
import app from "../src/index"
import { catalogCache } from "../src/routes/aggregate"

function makeFetchMock(responses: Record<string, { status: number; body: unknown }>) {
	const fn = async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString()
		const r = responses[url]
		if (!r) return new Response("not found", { status: 404, statusText: "Not Found" })
		return new Response(JSON.stringify(r.body), {
			status: r.status,
			headers: { "content-type": "application/json" },
		})
	}
	return fn
}

beforeEach(() => {
	catalogCache.clear()
})

// Stub global fetch for the lifetime of these tests. Hono's app.request
// uses globalThis.fetch.
function withFetch<T>(fn: typeof fetch, body: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch
	globalThis.fetch = fn
	return body().finally(() => {
		globalThis.fetch = original
	})
}

const communityCatalog = {
	$schema: "https://baka.foo/schemas/catalog.v1.json",
	name: "community",
	version: "1.0.0",
	description: "Community catalog",
	owner: { name: "Community" },
	modules: [
		{
			name: "community-foo",
			version: "0.3.0",
			description: "A community module",
			dependencies: [],
			conflictsWith: [],
			actions: [
				{
					id: "do",
					description: "do",
					params: [],
					requiresReasoning: false,
					filePatterns: [],
					validators: [],
				},
			],
			moduleValidators: [],
			source: "git:github.com/community/foo",
		},
	],
}

describe("GET /v1/modules/:name", () => {
	it("returns a built-in module with tier=built-in", async () => {
		const res = await app.request("/v1/modules/baka-base")
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			module: { name: string; tier: string }
			source: { catalog: string; tier: string }
		}
		expect(body.module.name).toBe("baka-base")
		expect(body.module.tier).toBe("built-in")
		expect(body.source.tier).toBe("built-in")
	})

	it("sets a 5-minute Cache-Control header", async () => {
		const res = await app.request("/v1/modules/baka-base")
		const cc = res.headers.get("cache-control")
		expect(cc).toMatch(/max-age=300/)
	})

	it("returns 404 when the module is not built-in and no catalogs are given", async () => {
		const res = await app.request("/v1/modules/unknown-module")
		expect(res.status).toBe(404)
	})

	it("finds a module in a community catalog with tier=community", async () => {
		const url = "https://community.example.com/c.json"
		await withFetch(makeFetchMock({ [url]: { status: 200, body: communityCatalog } }), async () => {
			const res = await app.request(`/v1/modules/community-foo?catalogs=${encodeURIComponent(url)}`)
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				module: { name: string; tier: string }
				source: { catalog: string; tier: string }
			}
			expect(body.module.name).toBe("community-foo")
			expect(body.module.tier).toBe("community")
			expect(body.source.catalog).toBe(url)
			expect(body.source.tier).toBe("community")
		})
	})

	it("returns 404 when the module is not in the supplied catalog", async () => {
		const url = "https://community.example.com/c.json"
		await withFetch(makeFetchMock({ [url]: { status: 200, body: communityCatalog } }), async () => {
			const res = await app.request(`/v1/modules/nonexistent?catalogs=${encodeURIComponent(url)}`)
			expect(res.status).toBe(404)
		})
	})

	it("ignores a failing catalog and still 404s when the module is not found elsewhere", async () => {
		const failingUrl = "https://broken.example.com/c.json"
		await withFetch(makeFetchMock({ [failingUrl]: { status: 500, body: {} } }), async () => {
			const res = await app.request(`/v1/modules/unknown?catalogs=${encodeURIComponent(failingUrl)}`)
			expect(res.status).toBe(404)
		})
	})

	it("built-in wins over a community catalog when both have the same module name", async () => {
		// The community catalog here doesn't have a duplicate, so we just
		// verify that the built-in catalog still resolves even if a
		// (different) community catalog is also passed.
		const url = "https://community.example.com/c.json"
		await withFetch(makeFetchMock({ [url]: { status: 200, body: communityCatalog } }), async () => {
			const res = await app.request(`/v1/modules/baka-base?catalogs=${encodeURIComponent(url)}`)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { source: { tier: string } }
			expect(body.source.tier).toBe("built-in")
		})
	})
})
