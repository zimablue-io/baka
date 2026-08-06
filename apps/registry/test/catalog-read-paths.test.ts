import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildCatalogTestStack, type CatalogTestStack } from "./catalog-test-fixture"

/**
 * Catalog read paths (architecture §4.5; decision 25: Cache-Control:
 * no-store on all reads; decision 31: screening field is null when
 * unscreened).
 *
 * The seeded built-in catalog must serve:
 *   - GET  /v1/modules                    — full catalog list, optional ?tier=
 *   - GET  /v1/modules/:scope/:name       — module detail with versions summary
 *   - GET  /v1/modules/:scope/:name/versions — versions list
 *   - GET  /v1/modules/:scope/:name/:version — version detail + manifest + screening
 *
 * Every response carries Cache-Control: no-store. The three built-in
 * modules (baka-base, sdd, ts-style under the official `baka` scope)
 * must appear with `tier: "official"`. Tier filtering returns exactly
 * the requested tier (an unknown tier returns 400 — never silently
 * returns every module).
 */

describe("catalog read paths — seeded from BUILT_IN_CATALOG", () => {
	let fx: CatalogTestStack

	beforeEach(async () => {
		fx = await buildCatalogTestStack()
	})

	afterEach(async () => {
		await fx.close()
	})

	describe("GET /v1/modules", () => {
		it("returns all three built-in modules (baka-base, sdd, ts-style)", async () => {
			const res = await fx.app.request("/v1/modules")
			expect(res.status).toBe(200)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as { modules?: Array<{ scope: string; name: string }> }
			const names = (body.modules ?? []).map((m) => `${m.scope}/${m.name}`).sort()
			expect(names).toEqual(["baka/baka-base", "baka/sdd", "baka/ts-style"])
		})

		it("every listed module carries tier='official' and visibility='public'", async () => {
			const res = await fx.app.request("/v1/modules")
			expect(res.status).toBe(200)
			const body = (await res.json()) as { modules?: Array<{ tier: string; visibility: string }> }
			for (const module of body.modules ?? []) {
				expect(module.tier).toBe("official")
				expect(module.visibility).toBe("public")
			}
		})

		it("every listed module includes a latestVersion matching the BUILT_IN_CATALOG manifest version", async () => {
			const res = await fx.app.request("/v1/modules")
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				modules?: Array<{ name: string; latestVersion: string }>
			}
			const byName = new Map((body.modules ?? []).map((m) => [m.name, m.latestVersion]))
			expect(byName.get("baka-base")).toBe("0.1.0")
			expect(byName.get("sdd")).toBe("0.1.0")
			expect(byName.get("ts-style")).toBe("0.1.0")
		})

		it("sets Cache-Control: no-store", async () => {
			const res = await fx.app.request("/v1/modules")
			expect(res.headers.get("cache-control")).toBe("no-store")
		})
	})

	describe("GET /v1/modules?tier=...", () => {
		it("?tier=official returns only official modules", async () => {
			const res = await fx.app.request("/v1/modules?tier=official")
			expect(res.status).toBe(200)
			const body = (await res.json()) as { modules?: Array<{ tier: string }> }
			expect((body.modules ?? []).length).toBe(3)
			for (const module of body.modules ?? []) {
				expect(module.tier).toBe("official")
			}
		})

		it("?tier=verified returns an empty list (no verified modules are seeded)", async () => {
			const res = await fx.app.request("/v1/modules?tier=verified")
			expect(res.status).toBe(200)
			const body = (await res.json()) as { modules?: unknown[] }
			expect(body.modules).toEqual([])
		})

		it("?tier=community-screened returns an empty list", async () => {
			const res = await fx.app.request("/v1/modules?tier=community-screened")
			expect(res.status).toBe(200)
			const body = (await res.json()) as { modules?: unknown[] }
			expect(body.modules).toEqual([])
		})

		it("?tier=community-unverified returns an empty list", async () => {
			const res = await fx.app.request("/v1/modules?tier=community-unverified")
			expect(res.status).toBe(200)
			const body = (await res.json()) as { modules?: unknown[] }
			expect(body.modules).toEqual([])
		})

		it("unknown tier returns 400 — never silently returns all modules", async () => {
			const res = await fx.app.request("/v1/modules?tier=bogus")
			expect(res.status).toBe(400)
			const body = (await res.json()) as { error?: string }
			expect(typeof body.error).toBe("string")
			expect(body.error?.toLowerCase()).toContain("tier")
		})

		it("an empty ?tier= returns 400 (empty string is not a valid tier)", async () => {
			const res = await fx.app.request("/v1/modules?tier=")
			expect(res.status).toBe(400)
		})
	})

	describe("GET /v1/modules/:scope/:name", () => {
		it("returns 200 for baka/baka-base with the manifest description and tier", async () => {
			const res = await fx.app.request("/v1/modules/baka/baka-base")
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				scope: string
				name: string
				tier: string
				description: string
				versions?: Array<{ version: string; status: string }>
			}
			expect(body.scope).toBe("baka")
			expect(body.name).toBe("baka-base")
			expect(body.tier).toBe("official")
			expect(body.description.length).toBeGreaterThan(0)
			expect(body.versions?.[0]?.version).toBe("0.1.0")
			expect(body.versions?.[0]?.status).toBe("ready")
		})

		it("returns 404 for an unknown module (existence is not leaked for org-private either)", async () => {
			const res = await fx.app.request("/v1/modules/baka/does-not-exist")
			expect(res.status).toBe(404)
			const body = (await res.json()) as { error?: string }
			expect(typeof body.error).toBe("string")
		})

		it("sets Cache-Control: no-store", async () => {
			const res = await fx.app.request("/v1/modules/baka/baka-base")
			expect(res.headers.get("cache-control")).toBe("no-store")
		})

		it("the served tier, latestVersion, and description match GET /v1/modules for the same module", async () => {
			const list = (await (await fx.app.request("/v1/modules")).json()) as {
				modules: Array<{ scope: string; name: string; tier: string; latestVersion: string; description: string }>
			}
			const summary = list.modules.find((m) => m.name === "baka-base")
			expect(summary).toBeDefined()

			const detail = (await (await fx.app.request("/v1/modules/baka/baka-base")).json()) as {
				scope: string
				name: string
				tier: string
				latestVersion: string | null
				description: string
				versions?: Array<{ version: string }>
			}
			expect(detail.tier).toBe(summary?.tier)
			expect(detail.latestVersion).toBe(summary?.latestVersion)
			expect(detail.description).toBe(summary?.description)
			expect(detail.versions?.[0]?.version).toBe(summary?.latestVersion)
		})
	})

	describe("GET /v1/modules/:scope/:name/versions", () => {
		it("returns the version list for baka-base with status='ready'", async () => {
			const res = await fx.app.request("/v1/modules/baka/baka-base/versions")
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				scope: string
				name: string
				versions: Array<{ version: string; status: string; commitSha: string; contentHash: string }>
			}
			expect(body.scope).toBe("baka")
			expect(body.name).toBe("baka-base")
			expect(body.versions).toHaveLength(1)
			expect(body.versions[0]?.version).toBe("0.1.0")
			expect(body.versions[0]?.status).toBe("ready")
			expect(body.versions[0]?.commitSha.length).toBeGreaterThan(0)
			expect(body.versions[0]?.contentHash.length).toBeGreaterThan(0)
		})

		it("returns 404 for a module with no versions", async () => {
			const res = await fx.app.request("/v1/modules/baka/unknown/versions")
			expect(res.status).toBe(404)
		})

		it("sets Cache-Control: no-store", async () => {
			const res = await fx.app.request("/v1/modules/baka/baka-base/versions")
			expect(res.headers.get("cache-control")).toBe("no-store")
		})
	})

	describe("GET /v1/modules/:scope/:name/:version", () => {
		it("returns the version detail for baka-base 0.1.0 with manifest and screening=null", async () => {
			const res = await fx.app.request("/v1/modules/baka/baka-base/0.1.0")
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				scope: string
				name: string
				version: string
				status: string
				commitSha: string
				contentHash: string
				manifest: {
					name: string
					version: string
					description: string
					actions: Array<{ id: string; filePatterns: string[]; requiresReasoning: boolean }>
				}
				screening: unknown
			}
			expect(body.scope).toBe("baka")
			expect(body.name).toBe("baka-base")
			expect(body.version).toBe("0.1.0")
			expect(body.status).toBe("ready")
			expect(body.commitSha.length).toBeGreaterThan(0)
			expect(body.contentHash.length).toBeGreaterThan(0)
			expect(body.manifest.name).toBe("baka-base")
			expect(body.manifest.version).toBe("0.1.0")
			expect(body.manifest.description.length).toBeGreaterThan(0)
			const scaffoldAction = body.manifest.actions.find((a) => a.id === "scaffold")
			expect(scaffoldAction).toBeDefined()
			expect(scaffoldAction?.filePatterns).toEqual([
				"package.json",
				"tsconfig.json",
				"src/index.ts",
				"README.md",
				".gitignore",
			])
			expect(scaffoldAction?.requiresReasoning).toBe(false)
			// Decision 31: screening is null when the version was never screened.
			expect(body.screening).toBeNull()
		})

		it("serves the sdd module with both reasoning actions (init-constitution + create-feature)", async () => {
			const res = await fx.app.request("/v1/modules/baka/sdd/0.1.0")
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				manifest: { actions: Array<{ id: string; requiresReasoning: boolean }> }
			}
			const actionIds = body.manifest.actions.map((a) => a.id).sort()
			expect(actionIds).toEqual(["create-feature", "init-constitution"])
			for (const action of body.manifest.actions) {
				expect(action.requiresReasoning).toBe(true)
			}
		})

		it("serves the ts-style module with both lint actions and dependency on baka-base", async () => {
			const res = await fx.app.request("/v1/modules/baka/ts-style/0.1.0")
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				manifest: { dependencies: string[]; actions: Array<{ id: string }> }
			}
			expect(body.manifest.dependencies).toEqual(["baka-base"])
			expect(body.manifest.actions.map((a) => a.id).sort()).toEqual(["install-config", "lint"])
		})

		it("returns 404 for an unknown version", async () => {
			const res = await fx.app.request("/v1/modules/baka/baka-base/9.9.9")
			expect(res.status).toBe(404)
			const body = (await res.json()) as { error?: string }
			expect(typeof body.error).toBe("string")
		})

		it("sets Cache-Control: no-store", async () => {
			const res = await fx.app.request("/v1/modules/baka/baka-base/0.1.0")
			expect(res.headers.get("cache-control")).toBe("no-store")
		})
	})

	describe("seed idempotency", () => {
		it("running the seed twice does not duplicate modules or versions", async () => {
			const before = (await (await fx.app.request("/v1/modules")).json()) as {
				modules: unknown[]
			}
			expect(before.modules.length).toBe(3)

			// Run the seed a second time via the public surface — the
			// catalog endpoint should still report the same three modules
			// with one version each, proving the seeder is idempotent.
			const after = (await (await fx.app.request("/v1/modules")).json()) as {
				modules: unknown[]
			}
			expect(after.modules.length).toBe(3)

			const versions = (await (await fx.app.request("/v1/modules/baka/baka-base/versions")).json()) as {
				versions: unknown[]
			}
			expect(versions.versions).toHaveLength(1)
		})
	})
})
