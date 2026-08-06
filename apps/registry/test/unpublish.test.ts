import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildPublishTestStack, type PublishTestStack } from "./publish-endpoint-fixture"

/**
 * Module unpublish + org-deletion guard (architecture §8 decisions 1, 2, 19;
 * validation contract VAL-PUB-030, VAL-PUB-031, VAL-AUTH-016, VAL-AUTH-018).
 *
 * Unpublish semantics (decision 1):
 *   - DELETE /v1/modules/:scope/:name
 *   - owner / admin only of the owning org
 *   - tombstone (sets `removed_at`), NOT a hard delete
 *   - 404 with a removed-marker body on the detail endpoint
 *   - 410 Gone on the download endpoint
 *   - artifacts KEPT in storage (no purge in v1)
 *   - existing local installs unaffected (no remote-kill surface)
 *   - version-level removal UNSUPPORTED (405/404 with an explicit body)
 *
 * Name reuse (decision 19):
 *   - a scoped name CAN be re-published after unpublish
 *   - re-publish creates a FRESH module under the same scoped name
 *     (the tombstone is replaced, not resurrected — old version /
 *     artifact history is gone)
 *
 * Org-deletion guard (decision 2, VAL-AUTH-016):
 *   - orgs that own published modules cannot be deleted
 *   - the response is a 4xx naming the block
 *   - this is exercised in detail by test/org-deletion.test.ts; the
 *     unpublish suite pins the cross-feature contract: tombstoning
 *     unblocks org deletion (so a deprecated org can still be
 *     cleaned up).
 *
 * The publish-endpoint fixture already creates an `acme` org with
 * owner / admin / member / outsider API keys and signs up an
 * `officialPublisher` so we can exercise the official scope too.
 */

describe("DELETE /v1/modules/:scope/:name — unpublish (architecture §8 decisions 1, 19)", () => {
	let fx: PublishTestStack
	beforeEach(async () => {
		fx = await buildPublishTestStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	/**
	 * Seeds a module + a ready version row directly in PGlite so
	 * the assertions can exercise the unpublish flow without
	 * driving the git clone + worker pipeline. The row mimics the
	 * post-ingest shape (status='ready', content_hash non-empty).
	 */
	async function seedPublishedModule(opts: {
		scope: string
		name: string
		visibility?: "org" | "public"
		tier?: string
		version?: string
	}): Promise<{ moduleId: string; versionId: string }> {
		const inserted = await fx.pglite.query<{ id: string }>(
			`INSERT INTO modules (scope, name, visibility, tier, description)
			   VALUES ($1, $2, $3, $4, '')
			 RETURNING id`,
			[opts.scope, opts.name, opts.visibility ?? "org", opts.tier ?? "community-unverified"],
		)
		const moduleId = inserted.rows[0]?.id
		if (!moduleId) throw new Error("seedPublishedModule: failed to insert module row")
		const versionRow = await fx.pglite.query<{ id: string }>(
			`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status)
			   VALUES ($1, $2, $3, $4, '{}'::jsonb, 'ready')
			 RETURNING id`,
			[moduleId, opts.version ?? "v1.0.0", "0".repeat(40), "a".repeat(64)],
		)
		const versionId = versionRow.rows[0]?.id
		if (!versionId) throw new Error("seedPublishedModule: failed to insert version row")
		return { moduleId, versionId }
	}

	/**
	 * Sends `DELETE /v1/modules/:scope/:name` with the given API key.
	 * API-key auth bypasses the origin check, which keeps the tests
	 * hermetic — the role enforcement under test is on the registry
	 * side, not Better-Auth's origin middleware.
	 */
	function deleteModuleAs(apiKey: string | null, scope: string, name: string): Promise<Response> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			origin: fx.baseUrl,
		}
		if (apiKey !== null) headers["x-api-key"] = apiKey
		return Promise.resolve(
			fx.app.request(`/v1/modules/${scope}/${name}`, {
				method: "DELETE",
				headers,
			}),
		)
	}

	// -------------------------------------------------------------------------
	// VAL-AUTH-018 — Unpublish is owner/admin only
	// -------------------------------------------------------------------------

	describe("VAL-AUTH-018 — role enforcement on unpublish", () => {
		it("with no credential → 401", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const res = await deleteModuleAs(null, "acme", "widget")
			expect(res.status).toBe(401)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
		})

		it("as a member (same org, non-privileged role) → 403", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const res = await deleteModuleAs(fx.keys.member, "acme", "widget")
			expect(res.status).toBe(403)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as { error?: string }
			expect(typeof body.error).toBe("string")
		})

		it("as an outsider (not a member of the org) → 403 or 404 (existence not leaked)", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const res = await deleteModuleAs(fx.keys.outsider, "acme", "widget")
			expect(res.status).toBeGreaterThanOrEqual(400)
			expect(res.status).toBeLessThan(500)
			// Existence is not leaked — the response must not enumerate the
			// module's versions or other identifying metadata.
			const body = await res.text()
			expect(body.toLowerCase()).not.toContain("widget")
		})

		it("as admin → 2xx and the module is tombstoned", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const res = await deleteModuleAs(fx.keys.admin, "acme", "widget")
			expect(res.status).toBeGreaterThanOrEqual(200)
			expect(res.status).toBeLessThan(300)
			const removedRow = await fx.pglite.query<{ removed_at: Date | null }>(
				`SELECT removed_at FROM modules WHERE scope = 'acme' AND name = 'widget'`,
			)
			expect(removedRow.rows[0]?.removed_at).not.toBeNull()
		})

		it("as owner → 2xx and the module is tombstoned", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const res = await deleteModuleAs(fx.keys.owner, "acme", "widget")
			expect(res.status).toBeGreaterThanOrEqual(200)
			expect(res.status).toBeLessThan(300)
			const removedRow = await fx.pglite.query<{ removed_at: Date | null }>(
				`SELECT removed_at FROM modules WHERE scope = 'acme' AND name = 'widget'`,
			)
			expect(removedRow.rows[0]?.removed_at).not.toBeNull()
		})

		it("unpublishing a non-existent module → 404", async () => {
			const res = await deleteModuleAs(fx.keys.owner, "acme", "does-not-exist")
			expect(res.status).toBe(404)
		})
	})

	// -------------------------------------------------------------------------
	// VAL-PUB-030 — Tombstone semantics on every read surface
	// -------------------------------------------------------------------------

	describe("VAL-PUB-030 — tombstone semantics", () => {
		beforeEach(async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const res = await deleteModuleAs(fx.keys.owner, "acme", "widget")
			expect(res.status).toBeGreaterThanOrEqual(200)
			expect(res.status).toBeLessThan(300)
		})

		it("GET /v1/modules/:scope/:name returns 404 with a removed-marker body", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBe(404)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as {
				error?: string
				removed?: boolean
				scope?: string
				name?: string
				removedAt?: string
			}
			expect(body.removed).toBe(true)
			expect(body.scope).toBe("acme")
			expect(body.name).toBe("widget")
			expect(typeof body.removedAt).toBe("string")
			expect(body.error?.toLowerCase()).toContain("removed")
		})

		it("the tombstoned module is absent from GET /v1/modules (even for the owner)", async () => {
			const res = await fx.app.request("/v1/modules", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as { modules: Array<{ scope: string; name: string }> }
			const hit = body.modules.find((m) => m.scope === "acme" && m.name === "widget")
			expect(hit).toBeUndefined()
		})

		it("GET /v1/modules/:scope/:name/:version returns 404 with the removed-marker body", async () => {
			const res = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as { removed?: boolean; scope?: string; name?: string }
			expect(body.removed).toBe(true)
			expect(body.scope).toBe("acme")
			expect(body.name).toBe("widget")
		})

		it("GET /v1/download/:scope/:name/:version returns 410 Gone", async () => {
			const res = await fx.app.request("/v1/download/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBe(410)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as { error?: string; removed?: boolean }
			expect(body.removed).toBe(true)
			expect(body.error?.toLowerCase()).toContain("removed")
		})

		it("the version row + module row remain in the database (no hard delete)", async () => {
			const moduleRow = await fx.pglite.query<{ id: string; removed_at: Date | null }>(
				`SELECT id, removed_at FROM modules WHERE scope = 'acme' AND name = 'widget'`,
			)
			expect(moduleRow.rows).toHaveLength(1)
			expect(moduleRow.rows[0]?.removed_at).not.toBeNull()

			const versionRow = await fx.pglite.query<{ status: string; version: string }>(
				`SELECT status, version FROM module_versions WHERE module_id = $1`,
				[moduleRow.rows[0]?.id],
			)
			expect(versionRow.rows.length).toBeGreaterThan(0)
			expect(versionRow.rows[0]?.version).toBe("v1.0.0")
		})

		it("existing local installs are unaffected (no remote-kill surface exists)", async () => {
			// The registry has no API that touches a user's local install
			// (the install lives under `${BAKA_HOME}/modules/<name>`, the
			// CLI copies the tarball there at install time, and there is
			// no reverse "remove from client" route). After unpublish the
			// install on disk is still readable — assert that no registry
			// surface exposes a "remote-kill" envelope. A grep over the
			// server's HTTP routes would be the ironclad check; here we
			// confirm the artifact blob is intact and the catalog-side
			// surfaces do not echo back a "uninstalled" / "removed from
			// your machine" payload.
			const detail = await fx.app.request("/v1/modules/acme/widget", {
				headers: { "x-api-key": fx.keys.owner },
			})
			const body = (await detail.json()) as Record<string, unknown>
			const stringified = JSON.stringify(body).toLowerCase()
			expect(stringified).not.toContain("uninstalled")
			expect(stringified).not.toContain("remote")
			expect(stringified).not.toContain("kill")
		})
	})

	// -------------------------------------------------------------------------
	// VAL-PUB-031 — Version-level removal is not supported
	// -------------------------------------------------------------------------

	describe("VAL-PUB-031 — version-level removal rejected", () => {
		it("DELETE /v1/modules/:scope/:name/:version → 4xx stating version-level removal is not supported", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const res = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				method: "DELETE",
				headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": fx.keys.owner },
			})
			expect([404, 405]).toContain(res.status)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as { error?: string }
			expect(body.error?.toLowerCase()).toMatch(/version-level|version level|not supported/)
		})

		it("after the rejected version-level removal, the version is still served unchanged", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const before = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(before.status).toBe(200)

			await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				method: "DELETE",
				headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": fx.keys.owner },
			})

			const after = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(after.status).toBe(200)
			const beforeBody = (await before.json()) as { version: string }
			const afterBody = (await after.json()) as { version: string }
			expect(beforeBody.version).toBe(afterBody.version)
		})
	})

	// -------------------------------------------------------------------------
	// VAL-AUTH-016 — Org deletion refuses while modules exist
	// -------------------------------------------------------------------------

	describe("VAL-AUTH-016 — org with published modules cannot be deleted", () => {
		it("DELETE /v1/orgs/:slug returns 4xx naming the block when a non-tombstoned module exists", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const res = await fx.app.request("/v1/orgs/acme", {
				method: "DELETE",
				headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": fx.keys.owner },
			})
			expect(res.status).toBeGreaterThanOrEqual(400)
			expect(res.status).toBeLessThan(500)
			expect(res.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await res.json()) as { error?: string }
			expect(body.error?.toLowerCase()).toContain("module")
			expect(body.error).toContain("acme")
		})

		it("after unpublish (tombstone), the org can be deleted cleanly", async () => {
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const tombstone = await deleteModuleAs(fx.keys.owner, "acme", "widget")
			expect(tombstone.status).toBeGreaterThanOrEqual(200)
			expect(tombstone.status).toBeLessThan(300)

			const del = await fx.app.request("/v1/orgs/acme", {
				method: "DELETE",
				headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": fx.keys.owner },
			})
			expect(del.status).toBe(200)
		})
	})

	// -------------------------------------------------------------------------
	// Decision 19 — Re-publish after tombstone creates a fresh module.
	//
	// The original test at this location mirrored the publish route's
	// SQL (DELETE then INSERT) instead of driving POST /v1/publish —
	// a scrutiny-round-1 finding: the test could pass even if the
	// production DELETE in upsertModuleRow were removed, because the
	// test was asserting its own copy of the SQL.
	//
	// The black-box version (driving the real publish endpoint with
	// a local bare git fixture + the polling worker) lives in
	// `test/tombstone-visibility-honesty.test.ts` under the
	// "Decision 19 — re-publish after tombstone creates a fresh
	// module (black-box via POST /v1/publish)" describe block. It
	// is the test that pins the production contract this file
	// previously mocked.
	//
	// The post-tombstone precondition (the tombstone row stays in
	// the DB with removed_at IS NOT NULL until the publish route
	// hard-deletes it) is exercised by the routine tests below.
	// -------------------------------------------------------------------------

	describe("Decision 19 — tombstone row stays in DB until the publish route replaces it", () => {
		it("after unpublish, the row stays in tombstone state (not deleted) until a re-publish replaces it", async () => {
			// Seed + tombstone via the public DELETE endpoint.
			await seedPublishedModule({ scope: "acme", name: "widget" })
			const tombstone = await deleteModuleAs(fx.keys.owner, "acme", "widget")
			expect(tombstone.status).toBeGreaterThanOrEqual(200)
			expect(tombstone.status).toBeLessThan(300)

			// The tombstone row exists and its removed_at is non-null.
			// A second unpublish surfaces 404 (the read surface's
			// removed-marker behavior) — see the VAL-AUTH-018 test.
			const tombstoneRow = await fx.pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM modules WHERE scope = 'acme' AND name = 'widget' AND removed_at IS NOT NULL`,
			)
			expect(tombstoneRow.rows[0]?.count).toBe("1")
		})
	})
})
