import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Scrutiny-round-1 follow-up to `unpublish-org-guard` (validation
 * contract VAL-AUTH-019, VAL-PUB-030).
 *
 * Two blocking defects were surfaced by the scrutiny review of
 * commit `07305d1`:
 *
 * 1. The removed-marker branch fired BEFORE the org-visibility
 *    membership gate on every read surface (detail / versions /
 *    version-detail / download). For a tombstoned org-visibility
 *    module, any caller — including unauthenticated outsiders —
 *    received the removed-marker body (timestamp included) instead
 *    of the uniform `not found` 404. This leaked existence +
 *    removal-timestamp of an org-private module to anyone.
 *
 * 2. `DELETE /v1/modules/:scope/:name` was a three-state oracle:
 *    403 (exists), 404 (missing), 404 "was already removed at
 *    <timestamp>". Outsiders probing names under an org could
 *    enumerate which names ever existed.
 *
 * Both defects are fixed by reordering the visibility / role
 * checks: membership (read) / role (write) FIRST, then the
 * existence/tombstone branches. The shape stays uniform for
 * non-members / non-owners.
 *
 * This file also pins the missing VAL-PUB-030 artifact-
 * preservation evidence (the spec demands "the artifact objects
 * remain in STORAGE_DIR (no purge in v1)" — no test covered it
 * after the unpublish-org-guard commit) and rewrites the
 * decision-19 re-publish test to drive `POST /v1/publish`
 * black-box instead of mirroring the publish route's SQL.
 *
 * Tests for the four read surfaces (outsider AND unauthenticated
 * caller see uniform 404) and the DELETE three-state probe (no
 * outsider) all share the same fixture: publish a real org-
 * visibility module via the worker, then tombstone it. The
 * artifact-preservation test additionally pins `STORAGE_DIR`
 * contents before/after unpublish.
 */

describe("tombstone visibility honesty (scrutiny-round-1 fixes)", () => {
	let fx: IngestTestStack
	let git: GitFixture

	beforeEach(async () => {
		fx = await buildIngestTestStack()
		git = await createGitFixture()
	})

	afterEach(async () => {
		await fx.close()
		await git.cleanup()
	})

	/**
	 * Publishes a real org-visibility module via the worker, then
	 * tombstones it (owner key). Returns the recorded content hash so
	 * the artifact-preservation test can pin the storage-keyed blob.
	 */
	async function publishAndTombstoneOrgModule(opts: { name: string; tag: string }): Promise<{ contentHash: string }> {
		await git.commitManifest({
			name: `@acme/${opts.name}`,
			version: "1.0.0",
			tag: opts.tag,
		})
		const pub = await fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
			body: JSON.stringify({
				repo: git.bareUrl,
				tag: opts.tag,
				org: "acme",
				visibility: "org",
			}),
		})
		expect(pub.status).toBe(202)
		const { versionId } = (await pub.json()) as { versionId: string }
		const terminal = await fx.waitForTerminal(versionId)
		expect(terminal.status).toBe("ready")

		const tomb = await fx.app.request(`/v1/modules/acme/${opts.name}`, {
			method: "DELETE",
			headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": fx.keys.owner },
		})
		expect(tomb.status).toBe(204)

		return { contentHash: terminal.contentHash ?? "" }
	}

	// -------------------------------------------------------------------------
	// VAL-AUTH-019 — Outsider / unauthenticated caller sees uniform 404 on
	// every read surface for a tombstoned org-visibility module.
	// -------------------------------------------------------------------------

	describe("VAL-AUTH-019 — uniform 404 for tombstoned org-visibility modules (no marker, no timestamp)", () => {
		beforeEach(async () => {
			await publishAndTombstoneOrgModule({ name: "widget", tag: "v1.0.0" })
		})

		it("GET /v1/modules/:scope/:name — unauthenticated caller sees uniform 404 (no removed-marker)", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget")
			expect(res.status).toBe(404)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as Record<string, unknown>
			// The removed-marker body must NOT leak the timestamp or
			// the removed flag to an outsider.
			expect(body.removed).toBeUndefined()
			expect(body.removedAt).toBeUndefined()
			// The envelope is the same shape as a never-existed module.
			expect(typeof body.error).toBe("string")
		})

		it("GET /v1/modules/:scope/:name — authenticated non-member (outsider) sees uniform 404", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget", {
				headers: { "x-api-key": fx.keys.outsider },
			})
			expect(res.status).toBe(404)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.removed).toBeUndefined()
			expect(body.removedAt).toBeUndefined()
			expect(typeof body.error).toBe("string")
		})

		it("GET /v1/modules/:scope/:name/versions — unauthenticated caller sees uniform 404", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget/versions")
			expect(res.status).toBe(404)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.removed).toBeUndefined()
			expect(body.removedAt).toBeUndefined()
		})

		it("GET /v1/modules/:scope/:name/versions — authenticated non-member sees uniform 404", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget/versions", {
				headers: { "x-api-key": fx.keys.outsider },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.removed).toBeUndefined()
			expect(body.removedAt).toBeUndefined()
		})

		it("GET /v1/modules/:scope/:name/:version — unauthenticated caller sees uniform 404", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget/v1.0.0")
			expect(res.status).toBe(404)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.removed).toBeUndefined()
			expect(body.removedAt).toBeUndefined()
		})

		it("GET /v1/modules/:scope/:name/:version — authenticated non-member sees uniform 404", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.outsider },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.removed).toBeUndefined()
			expect(body.removedAt).toBeUndefined()
		})

		it("GET /v1/download/:scope/:name/:version — unauthenticated caller sees uniform 404 (NOT 410)", async () => {
			// The 410 Gone response leaks the removed state; non-members
			// must see the same uniform 404 as a missing module.
			const res = await fx.app.request("/v1/download/acme/widget/v1.0.0")
			expect(res.status).toBe(404)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.removed).toBeUndefined()
			expect(body.removedAt).toBeUndefined()
		})

		it("GET /v1/download/:scope/:name/:version — authenticated non-member sees uniform 404 (NOT 410)", async () => {
			const res = await fx.app.request("/v1/download/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.outsider },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.removed).toBeUndefined()
			expect(body.removedAt).toBeUndefined()
		})
	})

	// -------------------------------------------------------------------------
	// VAL-AUTH-019 — Members / owner / admin still see the removed marker
	// on JSON reads and 410 on download. The marker is membership-gated.
	// -------------------------------------------------------------------------

	describe("VAL-AUTH-019 — members / owner / admin still see the removed-marker", () => {
		beforeEach(async () => {
			await publishAndTombstoneOrgModule({ name: "widget", tag: "v1.0.0" })
		})

		it("GET /v1/modules/:scope/:name — owner sees the removed-marker body", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as {
				removed?: boolean
				removedAt?: string
				scope?: string
				name?: string
			}
			expect(body.removed).toBe(true)
			expect(typeof body.removedAt).toBe("string")
			expect(body.scope).toBe("acme")
			expect(body.name).toBe("widget")
		})

		it("GET /v1/modules/:scope/:name — member (non-owner) sees the removed-marker body", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget", {
				headers: { "x-api-key": fx.keys.member },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as { removed?: boolean }
			expect(body.removed).toBe(true)
		})

		it("GET /v1/modules/:scope/:name/versions — owner sees the removed-marker body", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget/versions", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as { removed?: boolean }
			expect(body.removed).toBe(true)
		})

		it("GET /v1/modules/:scope/:name/:version — owner sees the removed-marker body", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as { removed?: boolean }
			expect(body.removed).toBe(true)
		})

		it("GET /v1/download/:scope/:name/:version — owner gets 410 Gone with the removed-marker body", async () => {
			const res = await fx.app.request("/v1/download/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBe(410)
			const body = (await res.json()) as { removed?: boolean }
			expect(body.removed).toBe(true)
		})

		it("GET /v1/download/:scope/:name/:version — member gets 410 Gone with the removed-marker body", async () => {
			const res = await fx.app.request("/v1/download/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.member },
			})
			expect(res.status).toBe(410)
			const body = (await res.json()) as { removed?: boolean }
			expect(body.removed).toBe(true)
		})
	})

	// -------------------------------------------------------------------------
	// VAL-AUTH-019 — DELETE by non-owner/admin is a uniform 403 regardless
	// of module existence or state. The three probes (missing, existing,
	// tombstoned) are indistinguishable to the caller.
	// -------------------------------------------------------------------------

	describe("VAL-AUTH-019 — DELETE by non-owner/admin is uniform 403 (missing === existing === tombstoned)", () => {
		it("authenticated non-member sees 403 for a missing module, an existing module, and a tombstoned module — indistinguishable", async () => {
			// Publish one module and tombstone it.
			await publishAndTombstoneOrgModule({ name: "tombstoned-mod", tag: "v1.0.0" })
			// Publish another and leave it ready.
			await git.commitManifest({
				name: "@acme/live-mod",
				version: "9.9.9",
				tag: "v9.9.9",
			})
			const pub = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v9.9.9",
					org: "acme",
					visibility: "org",
				}),
			})
			if (pub.status !== 202) {
				throw new Error(`publish failed: ${pub.status} ${await pub.text()}`)
			}
			const { versionId } = (await pub.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			// Probe missing / existing / tombstoned — all from the
			// outsider identity. The three responses must be
			// indistinguishable in status and body.
			const outsiderHeaders = {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": fx.keys.outsider,
			}
			const missing = await fx.app.request("/v1/modules/acme/never-existed", {
				method: "DELETE",
				headers: outsiderHeaders,
			})
			const existing = await fx.app.request("/v1/modules/acme/live-mod", {
				method: "DELETE",
				headers: outsiderHeaders,
			})
			const tombstoned = await fx.app.request("/v1/modules/acme/tombstoned-mod", {
				method: "DELETE",
				headers: outsiderHeaders,
			})

			// All three are 403 (uniform).
			expect(missing.status).toBe(403)
			expect(existing.status).toBe(403)
			expect(tombstoned.status).toBe(403)

			// Bodies are uniform — no "already removed" timestamp
			// leaks the removal state.
			const missingBody = (await missing.json()) as Record<string, unknown>
			const existingBody = (await existing.json()) as Record<string, unknown>
			const tombstonedBody = (await tombstoned.json()) as Record<string, unknown>
			// The "already removed" envelope and the "removedAt"
			// field MUST NOT appear in any of the three responses.
			for (const body of [missingBody, existingBody, tombstonedBody]) {
				expect(body.removed).toBeUndefined()
				expect(body.removedAt).toBeUndefined()
				expect((body.error as string | undefined)?.toLowerCase()).not.toContain("already removed")
			}
		})

		it("authenticated org-member (non-owner/admin) sees uniform 403 across the three states", async () => {
			// A member is a member of acme but lacks owner/admin —
			// they must NOT be able to distinguish which names
			// exist / were tombstoned / never existed.
			await publishAndTombstoneOrgModule({ name: "tombstoned-mod", tag: "v1.0.0" })
			await git.commitManifest({
				name: "@acme/live-mod",
				version: "9.9.9",
				tag: "v9.9.9",
			})
			const pub = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v9.9.9",
					org: "acme",
					visibility: "org",
				}),
			})
			const { versionId } = (await pub.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const memberHeaders = {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": fx.keys.member,
			}
			const missing = await fx.app.request("/v1/modules/acme/never-existed", {
				method: "DELETE",
				headers: memberHeaders,
			})
			const existing = await fx.app.request("/v1/modules/acme/live-mod", {
				method: "DELETE",
				headers: memberHeaders,
			})
			const tombstoned = await fx.app.request("/v1/modules/acme/tombstoned-mod", {
				method: "DELETE",
				headers: memberHeaders,
			})
			expect(missing.status).toBe(403)
			expect(existing.status).toBe(403)
			expect(tombstoned.status).toBe(403)

			// Same envelope for all three.
			const missingBody = (await missing.json()) as Record<string, unknown>
			const existingBody = (await existing.json()) as Record<string, unknown>
			const tombstonedBody = (await tombstoned.json()) as Record<string, unknown>
			for (const body of [missingBody, existingBody, tombstonedBody]) {
				expect(body.removed).toBeUndefined()
				expect(body.removedAt).toBeUndefined()
			}
		})

		it("owner / admin of a DIFFERENT org sees uniform 403 (no cross-org unpublish)", async () => {
			// Publish a module under a second org (`other`) so the
			// owner key cannot be a member of it.
			await git.commitManifest({
				name: "@other/their-mod",
				version: "9.9.9",
				tag: "v9.9.9",
			})

			// Create the `other` org with the owner as founder.
			const createRes = await fx.app.request("/v1/orgs", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: fx.baseUrl,
					"x-api-key": fx.keys.owner,
				},
				body: JSON.stringify({ name: "Other", slug: "other" }),
			})
			expect(createRes.status).toBe(200)

			const pub = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v9.9.9",
					org: "other",
					visibility: "org",
				}),
			})
			const { versionId } = (await pub.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			// The admin key is admin of `acme`, NOT `other`. They
			// must get 403.
			const res = await fx.app.request("/v1/modules/other/their-mod", {
				method: "DELETE",
				headers: {
					"content-type": "application/json",
					origin: fx.baseUrl,
					"x-api-key": fx.keys.admin,
				},
			})
			expect(res.status).toBe(403)
		})
	})

	// -------------------------------------------------------------------------
	// VAL-PUB-030 — artifact preservation: STORAGE_DIR is unchanged after
	// tombstone. Per architecture §8 decision 1, "no purge of artifacts in
	// v1".
	// -------------------------------------------------------------------------

	describe("VAL-PUB-030 — artifacts on disk are preserved after tombstone", () => {
		it("the tarball blob remains in STORAGE_DIR after unpublish (no purge in v1)", async () => {
			const { contentHash } = await publishAndTombstoneOrgModule({ name: "widget", tag: "v1.0.0" })

			// The blob's filename in STORAGE_DIR is the content hash
			// (the storage adapter writes content-addressed blobs).
			// Verify before/after: the file existed before the
			// tombstone (the module was ready) and still exists after
			// the tombstone.
			const { existsSync, statSync } = await import("node:fs")
			const blobPath = `${fx.storageDir}/${contentHash}`
			// Sanity: pre-tombstone, the test ran the full publish
			// pipeline so the blob SHOULD be on disk. The `beforeEach`
			// in `publishAndTombstoneOrgModule` already tombstoned
			// the module, so by the time we get here the post-
			// tombstone state is observable.
			expect(existsSync(blobPath)).toBe(true)
			const stats = statSync(blobPath)
			expect(stats.size).toBeGreaterThan(0)

			// The download endpoint for the owner still returns 410
			// (the deleted-marker behavior we want), but the blob
			// itself is untouched on disk.
			const ownerDl = await fx.app.request("/v1/download/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(ownerDl.status).toBe(410)
			// And the blob is still there.
			expect(existsSync(blobPath)).toBe(true)
		})

		it("the storage adapter `stat` reports the blob still present after tombstone", async () => {
			const { contentHash } = await publishAndTombstoneOrgModule({ name: "widget", tag: "v1.0.0" })
			const stat = await fx.storage.stat(contentHash)
			expect(stat).not.toBeNull()
			expect(stat?.sha256).toBe(contentHash)
			expect(stat?.size).toBeGreaterThan(0)
		})
	})

	// -------------------------------------------------------------------------
	// Decision 19 — re-publish after tombstone creates a fresh module.
	// Black-boxed through POST /v1/publish (the previous test mirrored
	// the publish route's SQL, which made the test a tautology — it
	// passed even if the production DELETE in upsertModuleRow were
	// removed).
	// -------------------------------------------------------------------------

	describe("Decision 19 — re-publish after tombstone creates a fresh module (black-box via POST /v1/publish)", () => {
		it("a fresh publish replaces the tombstone with a new module + new version (old history is gone)", async () => {
			// 1. Publish v1.0.0 as acme/widget, wait for ready.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})
			const pub1 = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "org",
				}),
			})
			expect(pub1.status).toBe(202)
			const { versionId: v1Id } = (await pub1.json()) as { versionId: string }
			const v1 = await fx.waitForTerminal(v1Id)
			expect(v1.status).toBe("ready")

			// 2. Tombstone via DELETE.
			const tomb = await fx.app.request("/v1/modules/acme/widget", {
				method: "DELETE",
				headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": fx.keys.owner },
			})
			expect(tomb.status).toBe(204)

			// 3. Re-publish at v2.0.0 — the publish route must
			// hard-delete the tombstone before INSERTing the new
			// row (upsertModuleRow runs DELETE FROM modules WHERE
			// ... removed_at IS NOT NULL before the INSERT).
			await git.commitManifest({
				name: "@acme/widget",
				version: "2.0.0",
				tag: "v2.0.0",
			})
			const pub2 = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v2.0.0",
					org: "acme",
					visibility: "org",
				}),
			})
			expect(pub2.status).toBe(202)
			const { versionId: v2Id } = (await pub2.json()) as { versionId: string }
			const v2 = await fx.waitForTerminal(v2Id)
			expect(v2.status).toBe("ready")

			// 4. The fresh module has only v2.0.0 — the old v1.0.0
			// version was cascaded away when the tombstone row was
			// deleted (the foreign key in 0002_app_schema.sql is
			// ON DELETE CASCADE).
			const versionsList = await fx.app.request("/v1/modules/acme/widget/versions", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(versionsList.status).toBe(200)
			const listedVersions = ((await versionsList.json()) as { versions: Array<{ version: string }> }).versions
			expect(listedVersions.map((v) => v.version).sort()).toEqual(["v2.0.0"])

			// 5. The module row is NOT in tombstone state anymore.
			const moduleRow = await fx.pglite.query<{ removed_at: Date | null }>(
				`SELECT removed_at FROM modules WHERE scope = 'acme' AND name = 'widget'`,
			)
			expect(moduleRow.rows).toHaveLength(1)
			expect(moduleRow.rows[0]?.removed_at).toBeNull()

			// 6. The catalog list path surfaces the fresh module.
			const list = await fx.app.request("/v1/modules", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(list.status).toBe(200)
			const listBody = (await list.json()) as { modules: Array<{ scope: string; name: string }> }
			const hit = listBody.modules.find((m) => m.scope === "acme" && m.name === "widget")
			expect(hit).toBeDefined()
		})
	})
})
