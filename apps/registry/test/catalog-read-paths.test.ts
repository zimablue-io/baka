import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedCatalogModules } from "../src/catalog/seed"
import { buildCatalogTestStack, type CatalogTestStack } from "./catalog-test-fixture"
import { TEST_CATALOG_MODULE } from "./test-catalog-module"

/**
 * Catalog read paths. Production BUILT_IN_CATALOG is empty.
 * This suite inserts one fixture module so list/detail/version
 * have a row to serve.
 */
describe("catalog read paths", () => {
	let fx: CatalogTestStack

	beforeEach(async () => {
		fx = await buildCatalogTestStack()
	})

	afterEach(async () => {
		await fx.close()
	})

	describe("GET /v1/modules", () => {
		it("lists the fixture module under the official scope", async () => {
			const res = await fx.app.request("/v1/modules")
			expect(res.status).toBe(200)
			expect(res.headers.get("cache-control")).toBe("no-store")
			const body = (await res.json()) as { modules?: Array<{ scope: string; name: string; tier: string }> }
			expect((body.modules ?? []).map((m) => `${m.scope}/${m.name}`)).toEqual(["baka/hello"])
			expect(body.modules?.[0]?.tier).toBe("official")
		})

		it("?tier=official returns the fixture; unknown tier is 400", async () => {
			const official = await fx.app.request("/v1/modules?tier=official")
			expect(official.status).toBe(200)
			const body = (await official.json()) as { modules?: unknown[] }
			expect(body.modules).toHaveLength(1)

			const verified = await fx.app.request("/v1/modules?tier=verified")
			expect(((await verified.json()) as { modules?: unknown[] }).modules).toEqual([])

			const bogus = await fx.app.request("/v1/modules?tier=bogus")
			expect(bogus.status).toBe(400)
		})

		it("seedCatalogModules is idempotent", async () => {
			await seedCatalogModules(fx.pglite, "baka", [TEST_CATALOG_MODULE])
			const res = await fx.app.request("/v1/modules")
			const body = (await res.json()) as { modules?: unknown[] }
			expect(body.modules).toHaveLength(1)
		})
	})

	describe("GET /v1/modules/:scope/:name", () => {
		it("returns hello with versions and Cache-Control: no-store", async () => {
			const res = await fx.app.request("/v1/modules/baka/hello")
			expect(res.status).toBe(200)
			expect(res.headers.get("cache-control")).toBe("no-store")
			const body = (await res.json()) as {
				scope: string
				name: string
				tier: string
				latestVersion: string
				description: string
			}
			expect(body).toMatchObject({
				scope: "baka",
				name: "hello",
				tier: "official",
				latestVersion: "0.1.0",
			})
			expect(body.description.length).toBeGreaterThan(0)
		})

		it("returns 404 for an unknown module", async () => {
			const res = await fx.app.request("/v1/modules/baka/does-not-exist")
			expect(res.status).toBe(404)
		})
	})

	describe("GET /v1/modules/:scope/:name/versions and :version", () => {
		it("lists the ready 0.1.0 version with screening=null", async () => {
			const versions = await fx.app.request("/v1/modules/baka/hello/versions")
			expect(versions.status).toBe(200)
			const list = (await versions.json()) as {
				versions: Array<{ version: string; status: string }>
			}
			expect(list.versions).toEqual([expect.objectContaining({ version: "0.1.0", status: "ready" })])

			const detail = await fx.app.request("/v1/modules/baka/hello/0.1.0")
			expect(detail.status).toBe(200)
			expect(detail.headers.get("cache-control")).toBe("no-store")
			const body = (await detail.json()) as {
				manifest: { name: string; actions: Array<{ id: string }> }
				screening: unknown
			}
			expect(body.manifest.name).toBe("hello")
			expect(body.manifest.actions.map((a) => a.id)).toEqual(["greet"])
			expect(body.screening).toBeNull()
		})

		it("returns 404 for an unknown version", async () => {
			const res = await fx.app.request("/v1/modules/baka/hello/9.9.9")
			expect(res.status).toBe(404)
		})
	})
})
