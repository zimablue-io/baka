import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedCatalogPacks } from "../src/catalog/seed"
import { buildCatalogTestStack, type CatalogTestStack } from "./catalog-test-fixture"
import { TEST_CATALOG_PACK } from "./test-catalog-pack"

/**
 * Catalog read paths. Production BUILT_IN_CATALOG is empty.
 * This suite inserts one fixture pack so list/detail/version
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

	describe("GET /v1/packs", () => {
		it("lists the fixture pack under the official scope", async () => {
			const res = await fx.app.request("/v1/packs")
			expect(res.status).toBe(200)
			expect(res.headers.get("cache-control")).toBe("no-store")
			const body = (await res.json()) as { packs?: Array<{ scope: string; name: string; tier: string }> }
			expect((body.packs ?? []).map((m) => `${m.scope}/${m.name}`)).toEqual(["baka/hello"])
			expect(body.packs?.[0]?.tier).toBe("official")
		})

		it("?tier=official returns the fixture; unknown tier is 400", async () => {
			const official = await fx.app.request("/v1/packs?tier=official")
			expect(official.status).toBe(200)
			const body = (await official.json()) as { packs?: unknown[] }
			expect(body.packs).toHaveLength(1)

			const verified = await fx.app.request("/v1/packs?tier=verified")
			expect(((await verified.json()) as { packs?: unknown[] }).packs).toEqual([])

			const bogus = await fx.app.request("/v1/packs?tier=bogus")
			expect(bogus.status).toBe(400)
		})

		it("seedCatalogPacks is idempotent", async () => {
			await seedCatalogPacks(fx.pglite, "baka", [TEST_CATALOG_PACK])
			const res = await fx.app.request("/v1/packs")
			const body = (await res.json()) as { packs?: unknown[] }
			expect(body.packs).toHaveLength(1)
		})
	})

	describe("GET /v1/packs/:scope/:name", () => {
		it("returns hello with versions and Cache-Control: no-store", async () => {
			const res = await fx.app.request("/v1/packs/baka/hello")
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

		it("returns 404 for an unknown pack", async () => {
			const res = await fx.app.request("/v1/packs/baka/does-not-exist")
			expect(res.status).toBe(404)
		})
	})

	describe("GET /v1/packs/:scope/:name/versions and :version", () => {
		it("lists the ready 0.1.0 version with screening=null", async () => {
			const versions = await fx.app.request("/v1/packs/baka/hello/versions")
			expect(versions.status).toBe(200)
			const list = (await versions.json()) as {
				versions: Array<{ version: string; status: string }>
			}
			expect(list.versions).toEqual([expect.objectContaining({ version: "0.1.0", status: "ready" })])

			const detail = await fx.app.request("/v1/packs/baka/hello/0.1.0")
			expect(detail.status).toBe(200)
			expect(detail.headers.get("cache-control")).toBe("no-store")
			const body = (await detail.json()) as {
				manifest: { name: string; recipes: Array<{ id: string }> }
				screening: unknown
			}
			expect(body.manifest.name).toBe("hello")
			expect(body.manifest.recipes.map((a) => a.id)).toEqual(["greet"])
			expect(body.screening).toBeNull()
		})

		it("returns 404 for an unknown version", async () => {
			const res = await fx.app.request("/v1/packs/baka/hello/9.9.9")
			expect(res.status).toBe(404)
		})
	})
})
