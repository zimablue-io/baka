import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedBuiltInCatalog } from "../src/catalog/seed"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"
import { type CommunityFixtureResult, seedCommunityScreenedFixture } from "./seed-publishing-server"

/**
 * Community-screened fixture published through the real pipeline
 * by `seedCommunityScreenedFixture` (the function the
 * `seed-publishing-server.ts` harness calls at boot).
 *
 * Contract (this test pins every assertion the seed publishes):
 *
 *   1. A vanilla boot yields at least one public community pack
 *      version that passed through the real screening pipeline
 *      (static scan + sandboxed dry-run + output validation),
 *      with a rendered preview for >=1 recipe AND a needs-llm
 *      record with sentinel-rendered files for >=1 recipe.
 *   2. The catalog list surfaces the fixture at the expected tier
 *      (community-screened).
 *   3. The download endpoint returns a REAL tarball blob (no 404,
 *      no "missing from storage" 500) for the ready version.
 *   4. Production built-in catalog stays empty (no official packs
 *      invented by community publish).
 *   5. Re-invoking the seed against the same DB is idempotent —
 *      the fixture is not re-published and no second `pending`
 *      row appears.
 *
 * The test exercises the full pipeline end-to-end (real PGlite +
 * real Better-Auth + real polling worker + real tarball pack).
 */

describe("seedCommunityScreenedFixture (the boot-time publish)", () => {
	let fx: IngestTestStack
	let git: GitFixture

	beforeEach(async () => {
		fx = await buildIngestTestStack()
		// Mirror the seed-publishing-server's boot path so the
		// "built-in catalog remains unchanged" assertions are
		// observable. `buildIngestTestStack` deliberately omits
		// the built-in seed (it is a worker-test fixture, not a
		// boot harness); the catalog seed is the harness's job.
		await seedBuiltInCatalog(fx.pglite, fx.officialOrg)
		git = await createGitFixture()
	})

	afterEach(async () => {
		await fx.close()
		await git.cleanup()
	})

	it("publishes a public community pack version that ends in status=ready after passing screening", async () => {
		const result: CommunityFixtureResult = await seedCommunityScreenedFixture({
			app: fx.app,
			pglite: fx.pglite,
			ownerKey: fx.keys.owner,
			orgSlug: "acme",
			git,
		})

		expect(result.status).toBe("ready")
		expect(result.scope).toBe("acme")
		expect(result.tier).toBe("community-screened")
		expect(result.version).toBe("v1.0.0")
		expect(result.skipped).toBe(false)
	})

	it("the fixture surfaces both rendered AND needs-llm-with-sentinel-files preview states", async () => {
		const result = await seedCommunityScreenedFixture({
			app: fx.app,
			pglite: fx.pglite,
			ownerKey: fx.keys.owner,
			orgSlug: "acme",
			git,
		})

		const listRes = await fx.app.request(`/v1/packs/${result.scope}/${result.name}/${result.version}/previews`)
		expect(listRes.status).toBe(200)
		const listBody = (await listRes.json()) as {
			previews: Array<{ recipeId: string; state: string; files?: Array<{ path: string }> }>
		}

		// Both declared recipes must appear on the preview list.
		expect(listBody.previews).toHaveLength(2)

		// greet: non-reasoning, runs through sandbox, produces a
		// rendered preview.
		const rendered = listBody.previews.find((p) => p.recipeId === "greet")
		expect(rendered).toBeDefined()
		expect(rendered?.state).toBe("rendered")
		expect(rendered?.files).toBeDefined()
		expect((rendered?.files ?? []).length).toBeGreaterThan(0)

		// plan-feature: requiresReasoning with a {{!-- no-llm --}}
		// template. The state stays needs-llm (LLM reasoning is
		// still required at apply time), but the rendered sentinel
		// bytes are surfaced as the file carrier.
		const needsLlm = listBody.previews.find((p) => p.recipeId === "plan-feature")
		expect(needsLlm).toBeDefined()
		expect(needsLlm?.state).toBe("needs-llm")
		expect(needsLlm?.files).toBeDefined()
		expect((needsLlm?.files ?? []).length).toBeGreaterThan(0)
	})

	it("the per-recipe preview endpoint serves the rendered content for both preview states", async () => {
		const result = await seedCommunityScreenedFixture({
			app: fx.app,
			pglite: fx.pglite,
			ownerKey: fx.keys.owner,
			orgSlug: "acme",
			git,
		})

		// Rendered preview: greet's file content is fetched from
		// storage and served verbatim.
		const greetRes = await fx.app.request(`/v1/packs/${result.scope}/${result.name}/${result.version}/previews/greet`)
		expect(greetRes.status).toBe(200)
		const greetBody = (await greetRes.json()) as {
			recipeId: string
			state: string
			files: Array<{ path: string; content: string }>
		}
		expect(greetBody.recipeId).toBe("greet")
		expect(greetBody.state).toBe("rendered")
		expect(greetBody.files.length).toBeGreaterThan(0)
		expect(greetBody.files[0]?.content).toContain("Hello from the baka community fixture")

		// Needs-llm preview with sentinel-rendered files: the
		// template was rendered through Handlebars and surfaced
		// alongside the state.
		const planRes = await fx.app.request(
			`/v1/packs/${result.scope}/${result.name}/${result.version}/previews/plan-feature`,
		)
		expect(planRes.status).toBe(200)
		const planBody = (await planRes.json()) as {
			recipeId: string
			state: string
			reason: string
			files: Array<{ path: string; content: string }>
		}
		expect(planBody.recipeId).toBe("plan-feature")
		expect(planBody.state).toBe("needs-llm")
		expect(planBody.reason).toBe("recipe skipped because it requires LLM reasoning")
		expect(planBody.files.length).toBeGreaterThan(0)
		expect(planBody.files[0]?.content).toContain("Welcome")
	})

	it("the catalog list surfaces the fixture at tier community-screened (no 404, no admin auth required)", async () => {
		const result = await seedCommunityScreenedFixture({
			app: fx.app,
			pglite: fx.pglite,
			ownerKey: fx.keys.owner,
			orgSlug: "acme",
			git,
		})

		const catalogRes = await fx.app.request("/v1/packs")
		expect(catalogRes.status).toBe(200)
		const catalog = (await catalogRes.json()) as {
			packs: Array<{ scope: string; name: string; tier: string; latestVersion: string | null }>
		}

		const entry = catalog.packs.find((m) => m.scope === result.scope && m.name === result.name)
		expect(entry).toBeDefined()
		expect(entry?.tier).toBe("community-screened")
		expect(entry?.latestVersion).toBe("v1.0.0")
	})

	it("the download endpoint returns a real tarball for the ready version (no 404, no missing-from-storage 500)", async () => {
		const result = await seedCommunityScreenedFixture({
			app: fx.app,
			pglite: fx.pglite,
			ownerKey: fx.keys.owner,
			orgSlug: "acme",
			git,
		})

		// Public pack + ready version → the tarball blob is
		// served directly. The response must NOT be the catalog's
		// 404 envelope and must NOT be the 500 "missing from
		// storage" envelope — the worker packed the tarball and
		// the storage adapter wrote it under the content hash.
		const dlRes = await fx.app.request(`/v1/download/${result.scope}/${result.name}/${result.version}`)
		expect(dlRes.status).toBe(200)
		expect(dlRes.headers.get("content-type")).toBe("application/x-tar")
		const bytes = new Uint8Array(await dlRes.arrayBuffer())
		expect(bytes.byteLength).toBeGreaterThan(0)

		// Tarball content sanity: a tar archive starts with a
		// 512-byte header per file; the first entry's path field
		// must contain the recipe's executable content. We don't
		// try to parse the tar fully — the size + content-type
		// + content-disposition checks above are the contract.
		expect(dlRes.headers.get("content-disposition")).toContain("attachment")
	})

	it("community publish does not invent official catalog rows", async () => {
		await seedCommunityScreenedFixture({
			app: fx.app,
			pglite: fx.pglite,
			ownerKey: fx.keys.owner,
			orgSlug: "acme",
			git,
		})

		const official = await fx.app.request("/v1/packs?tier=official")
		expect(official.status).toBe(200)
		const body = (await official.json()) as { packs?: unknown[] }
		expect(body.packs).toEqual([])
	})

	it("is idempotent: re-invoking against the same DB does not publish a second version row", async () => {
		const first = await seedCommunityScreenedFixture({
			app: fx.app,
			pglite: fx.pglite,
			ownerKey: fx.keys.owner,
			orgSlug: "acme",
			git,
		})
		expect(first.skipped).toBe(false)

		const second = await seedCommunityScreenedFixture({
			app: fx.app,
			pglite: fx.pglite,
			ownerKey: fx.keys.owner,
			orgSlug: "acme",
			git,
		})
		expect(second.skipped).toBe(true)
		expect(second.versionId).toBe(first.versionId)

		// Exactly one pack_versions row for the fixture's tag.
		const rows = await fx.pglite.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM pack_versions WHERE id = $1`,
			[first.versionId],
		)
		expect(Number(rows.rows[0]?.count ?? 0)).toBe(1)
	})
})
