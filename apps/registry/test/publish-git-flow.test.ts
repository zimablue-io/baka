import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildPublishTestStack, type PublishTestStack } from "./publish-endpoint-fixture"

/**
 * POST /v1/publish — end-to-end with real local bare git repos.
 *
 * Exercises the clone-and-validate path that the request-level
 * tests in `publish-endpoint.test.ts` cannot reach:
 *   - VAL-PUB-002: publish accepted (202) with version record.
 *   - VAL-PUB-010: bare module name under a non-official org is
 *     rejected at publish time with a 422 naming the scoping rule.
 *   - VAL-PUB-024: a manifest whose `version` disagrees with the
 *     git tag is rejected at publish time with a 422 naming both
 *     values.
 *
 * The fixture is hermetic (local bare repos in tmp dirs); no
 * network calls. The `git-fixture` helper owns the lifecycle of
 * the bare repo and the working tree.
 */

describe("POST /v1/publish — clone-and-validate (VAL-PUB-002 / 010 / 024)", () => {
	let fx: PublishTestStack
	let git: GitFixture

	beforeEach(async () => {
		fx = await buildPublishTestStack()
		git = await createGitFixture()
	})

	afterEach(async () => {
		await fx.close()
		await git.cleanup()
	})

	describe("VAL-PUB-002: publish accepted and tracked", () => {
		it("returns 202 with a pending version record (scope, version, status=pending, commitSha)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				description: "acme widget",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
				}),
			})
			expect(res.status).toBe(202)
			const body = (await res.json()) as {
				scope: string
				name: string
				version: string
				status: string
				commitSha?: string
			}
			expect(body.scope).toBe("acme")
			expect(body.version).toBe("v1.0.0")
			expect(body.status).toBe("pending")
			expect(typeof body.commitSha).toBe("string")
			expect((body.commitSha ?? "").length).toBeGreaterThan(0)
		})

		it("the pending row is recorded in module_versions and the catalog reflects the new module", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(res.status).toBe(202)

			const versions = (await (
				await fx.app.request("/v1/modules/acme/widget/versions", {
					headers: { "x-api-key": fx.keys.owner },
				})
			).json()) as {
				versions?: Array<{ version: string; status: string }>
				error?: string
			}
			expect(versions.versions).toHaveLength(1)
			expect(versions.versions?.[0]?.version).toBe("v1.0.0")
			expect(versions.versions?.[0]?.status).toBe("pending")
		})

		it("defaults visibility to `org` when omitted (decision 30: private by default)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(res.status).toBe(202)
			const body = (await res.json()) as { visibility: string }
			expect(body.visibility).toBe("org")
		})

		it("a public-visibility publish flows through (the `community-unverified` tier is the starting point)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
				}),
			})
			expect(res.status).toBe(202)
			const body = (await res.json()) as { visibility: string; status: string }
			expect(body.visibility).toBe("public")
			expect(body.status).toBe("pending")
		})

		it("an unknown tag returns 422 (the worker would have to mark it failed; the publish endpoint fails fast)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v9.9.9", org: "acme" }),
			})
			expect(res.status).toBe(422)
			const body = (await res.json()) as { error?: string }
			expect(body.error).toContain("v9.9.9")
		})
	})

	describe("VAL-PUB-010: bare names rejected for non-official orgs", () => {
		it("returns 422 naming the scoping rule when a non-official org publishes a manifest with a bare name", async () => {
			await git.commitManifest({
				name: "my-module",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(res.status).toBe(422)
			const body = (await res.json()) as { error?: string }
			const error = body.error ?? ""
			expect(error).toContain("my-module")
			expect(error.toLowerCase()).toContain("bare")
			expect(error.toLowerCase()).toContain("official")
		})

		it("no module or version row is created when the bare-name rule rejects the publish", async () => {
			await git.commitManifest({
				name: "my-module",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})

			const modules = await fx.pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM modules WHERE scope = 'acme'`,
			)
			expect(Number.parseInt(modules.rows[0]?.count ?? "0", 10)).toBe(0)
		})

		it("a scoped name under acme (e.g. `acme/widget`) is accepted", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(res.status).toBe(202)
		})

		it("the official org accepts a bare name (decision 26: bare names live only under the official org)", async () => {
			await git.commitManifest({
				name: "official-mod",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.officialPublisher },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: fx.officialOrg }),
			})
			expect(res.status).toBe(202)
			const body = (await res.json()) as { scope: string; name: string }
			expect(body.scope).toBe(fx.officialOrg)
			expect(body.name).toBe("official-mod")
		})
	})

	describe("VAL-PUB-024: manifest/tag version mismatch", () => {
		it("returns 422 with both the tag and the manifest version when they disagree", async () => {
			// Tag is `v1.2.0` but the manifest declares `version: 1.0.0`.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.2.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.2.0", org: "acme" }),
			})
			expect(res.status).toBe(422)
			const body = (await res.json()) as { error?: string; tag?: string; manifestVersion?: string }
			expect(body.error).toContain("v1.2.0")
			expect(body.error).toContain("1.0.0")
			expect(body.tag).toBe("v1.2.0")
			expect(body.manifestVersion).toBe("1.0.0")
		})

		it("no module_versions row is created when the manifest/tag version mismatches", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.2.0",
			})

			await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.2.0", org: "acme" }),
			})

			const versions = await fx.pglite.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM module_versions`)
			expect(Number.parseInt(versions.rows[0]?.count ?? "0", 10)).toBe(0)
		})

		it("an exact match (tag `v1.0.0`, manifest `1.0.0`) is accepted (decision 11: served version equals git tag)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(res.status).toBe(202)
		})
	})

	// ----------------------------------------------------------------------------
	// Scrutiny-round-1 polish: visibility echo on re-publish, plan-limit semantics
	// for new versions, foreign-scope enforcement on the official-org path, and
	// empty moduleName rejection.
	// ----------------------------------------------------------------------------

	describe("VAL-SCRUTINY-1: re-publish reflects stored visibility, not the requested value", () => {
		it("re-publishing an existing module echoes the FIRST-publish visibility, not the requested one", async () => {
			await git.commitManifest({ name: "@acme/widget", version: "1.0.0", tag: "v1.0.0" })
			const first = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme", visibility: "org" }),
			})
			expect(first.status).toBe(202)
			expect(((await first.json()) as { visibility: string }).visibility).toBe("org")

			// Re-publish v2 with visibility: "public" — the row stays org
			// (first-publish wins on re-publish of the same module), so the
			// response must echo "org" rather than the requested "public".
			await git.commitManifest({ name: "@acme/widget", version: "1.0.1", tag: "v1.0.1" })
			const second = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.1", org: "acme", visibility: "public" }),
			})
			expect(second.status).toBe(202)
			const secondBody = (await second.json()) as { visibility: string }
			expect(secondBody.visibility).toBe("org")
		})
	})

	describe("VAL-SCRUTINY-1: plan limit counts modules, not versions", () => {
		it("publishing a new VERSION of an existing module is NOT blocked when at the max_private_modules limit", async () => {
			// Set the private-module quota to 1 so the first publish
			// creates the one allowed module. A second publish of a
			// new VERSION of the same module must succeed — the limit
			// counts modules, not versions.
			await fx.pglite.query(`UPDATE plan_limits SET max_private_modules = 1 WHERE plan = 'free'`)

			await git.commitManifest({ name: "@acme/widget", version: "1.0.0", tag: "v1.0.0" })
			const first = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme", visibility: "org" }),
			})
			expect(first.status).toBe(202)

			// New version, same module — must NOT 403 on plan limit.
			await git.commitManifest({ name: "@acme/widget", version: "1.0.1", tag: "v1.0.1" })
			const second = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.1", org: "acme", visibility: "org" }),
			})
			expect(second.status).toBe(202)
		})

		it("publishing a SECOND DIFFERENT module is still blocked at the limit", async () => {
			// Limit = 1, one module already exists. A second DIFFERENT
			// module must still 403 — the new-version carve-out is
			// specific to re-publishing the same (scope, name).
			await fx.pglite.query(`UPDATE plan_limits SET max_private_modules = 1 WHERE plan = 'free'`)

			await git.commitManifest({ name: "@acme/widget", version: "1.0.0", tag: "v1.0.0" })
			await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme", visibility: "org" }),
			})

			await git.commitManifest({ name: "@acme/gadget", version: "1.0.1", tag: "v1.0.1" })
			const second = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.1", org: "acme", visibility: "org" }),
			})
			expect(second.status).toBe(403)
			const body = (await second.json()) as { error?: string }
			expect(body.error?.toLowerCase()).toContain("max_private_modules")
		})
	})

	describe("VAL-SCRUTINY-1: official-org path rejects foreign-scope manifest names", () => {
		it("rejects a manifest named `@other/foo` published into the official scope with 422", async () => {
			await git.commitManifest({ name: "@other/foo", version: "1.0.0", tag: "v1.0.0" })

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.officialPublisher },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: fx.officialOrg }),
			})
			expect(res.status).toBe(422)
			const body = (await res.json()) as { error?: string }
			expect(body.error ?? "").toContain("@other/foo")
		})

		it("accepts a manifest named `@<officialOrg>/widget` (own scope is stripped)", async () => {
			await git.commitManifest({ name: `@${fx.officialOrg}/widget`, version: "1.0.0", tag: "v1.0.0" })

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.officialPublisher },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: fx.officialOrg }),
			})
			expect(res.status).toBe(202)
			const body = (await res.json()) as { scope: string; name: string }
			expect(body.scope).toBe(fx.officialOrg)
			expect(body.name).toBe("widget")
		})
	})

	describe("VAL-SCRUTINY-1: empty moduleName after scope strip is rejected", () => {
		it("rejects a manifest named `@<org>/` (scope stripped to empty)", async () => {
			await git.commitManifest({ name: "@acme/", version: "1.0.0", tag: "v1.0.0" })

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(res.status).toBe(422)
		})

		it("rejects a manifest named `@<org>//foo` (scope stripped to `/foo`)", async () => {
			await git.commitManifest({ name: "@acme//foo", version: "1.0.0", tag: "v1.0.0" })

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(res.status).toBe(422)
		})
	})
})
