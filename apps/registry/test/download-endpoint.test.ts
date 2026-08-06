import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Tarball download endpoint (architecture §4.5, VAL-PUB-007 /
 * VAL-PUB-017 / VAL-AUTH-003).
 *
 * `GET /v1/download/:scope/:name/:version` serves the tarball
 * artifact recorded on a ready `module_versions` row. Visibility
 * rules match the detail endpoint exactly: public modules are
 * downloadable by anyone; org-visibility modules are downloadable
 * only by members of the owning org. The body's sha256 equals
 * the `content_hash` on the version row, and the artifact is the
 * exact blob the storage adapter wrote during ingest.
 */

describe("tarball download endpoint (VAL-PUB-007 / VAL-PUB-017 / VAL-AUTH-003)", () => {
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

	describe("public module download", () => {
		it("serves the tarball body for a public-ready version with the recorded sha256", async () => {
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
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const dl = await fx.app.request("/v1/download/acme/widget/v1.0.0")
			expect(dl.status).toBe(200)
			expect(dl.headers.get("content-type")).toBe("application/x-tar")
			expect(dl.headers.get("cache-control")).toBe("no-store")
			expect(dl.headers.get("x-content-sha256")).toBe(terminal.contentHash)
			const body = new Uint8Array(await dl.arrayBuffer())
			// sha256 of the body must equal the recorded content hash.
			const { createHash } = await import("node:crypto")
			const sha = createHash("sha256").update(body).digest("hex")
			expect(sha).toBe(terminal.contentHash)
		})

		it("anonymous download works for a public module (no credential)", async () => {
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
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			// No `x-api-key` header — anonymous caller.
			const dl = await fx.app.request("/v1/download/acme/widget/v1.0.0")
			expect(dl.status).toBe(200)
			const body = new Uint8Array(await dl.arrayBuffer())
			expect(body.length).toBeGreaterThan(0)
		})

		it("returns 404 with a JSON body for a missing version on a public module", async () => {
			const dl = await fx.app.request("/v1/download/acme/widget/9.9.9")
			expect(dl.status).toBe(404)
			expect(dl.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await dl.json()) as { error?: string }
			expect(typeof body.error).toBe("string")
			expect(body.error?.length).toBeGreaterThan(0)
		})

		it("returns 404 for a pending version (no tarball yet)", async () => {
			// Manually insert a pending version row to simulate
			// "in-flight ingest" — the worker will pick it up but
			// before it finishes, the download endpoint should 404
			// because no artifact has been written yet.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const inserted = await fx.pglite.query<{ id: string }>(
				`INSERT INTO modules (scope, name, visibility, tier, description)
				 VALUES ('acme', 'pending-mod', 'public', 'community-unverified', '')
				 ON CONFLICT (scope, name) DO UPDATE SET updated_at = NOW()
				 RETURNING id`,
			)
			const moduleId = inserted.rows[0]?.id ?? ""
			const placeholderSha = "0".repeat(40)
			await fx.pglite.query(
				`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status)
				 VALUES ($1, 'v0.0.1', $2, '', $3::jsonb, 'pending')`,
				[
					moduleId,
					placeholderSha,
					JSON.stringify({
						name: "@acme/pending-mod",
						version: "0.0.1",
						description: "pending",
						dependencies: [],
						conflictsWith: [],
						actions: [
							{
								id: "noop",
								description: "noop",
								params: [],
								requiresReasoning: false,
								filePatterns: [],
								validators: [],
							},
						],
						moduleValidators: [],
					}),
				],
			)

			const dl = await fx.app.request("/v1/download/acme/pending-mod/v0.0.1")
			expect(dl.status).toBe(404)
			const body = (await dl.json()) as { error?: string }
			expect(typeof body.error).toBe("string")
		})
	})

	describe("org-visibility module download (VAL-AUTH-003 / VAL-PUB-017)", () => {
		it("anonymous caller receives 404 for an org-visibility module (existence is not leaked)", async () => {
			await git.commitManifest({
				name: "@acme/private-mod",
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
					visibility: "org",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const dl = await fx.app.request("/v1/download/acme/private-mod/v1.0.0")
			expect(dl.status).toBe(404)
			expect(dl.headers.get("content-type")).toMatch(/application\/json/)
			const body = (await dl.json()) as { error?: string }
			expect(typeof body.error).toBe("string")
			expect(body.error?.toLowerCase()).toContain("not found")
		})

		it("outsider (authenticated, not a member) receives 404 for an org-visibility module", async () => {
			await git.commitManifest({
				name: "@acme/private-mod",
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
					visibility: "org",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const dl = await fx.app.request("/v1/download/acme/private-mod/v1.0.0", {
				headers: { "x-api-key": fx.keys.outsider },
			})
			expect(dl.status).toBe(404)
			expect(dl.headers.get("content-type")).toMatch(/application\/json/)
		})

		it("org member downloads the tarball with the recorded sha256", async () => {
			await git.commitManifest({
				name: "@acme/private-mod",
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
					visibility: "org",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const dl = await fx.app.request("/v1/download/acme/private-mod/v1.0.0", {
				headers: { "x-api-key": fx.keys.member },
			})
			expect(dl.status).toBe(200)
			expect(dl.headers.get("x-content-sha256")).toBe(terminal.contentHash)
			const body = new Uint8Array(await dl.arrayBuffer())
			const { createHash } = await import("node:crypto")
			const sha = createHash("sha256").update(body).digest("hex")
			expect(sha).toBe(terminal.contentHash)
		})

		it("admin role is sufficient (any role counts, not just owner)", async () => {
			await git.commitManifest({
				name: "@acme/private-mod",
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
					visibility: "org",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const dl = await fx.app.request("/v1/download/acme/private-mod/v1.0.0", {
				headers: { "x-api-key": fx.keys.admin },
			})
			expect(dl.status).toBe(200)
		})

		it("a failed version returns 404 (no tarball was written)", async () => {
			await git.commitManifest({
				name: "@acme/private-mod",
				version: "1.0.0",
				actions: [{ id: "unloadable", description: "no action.ts", loadable: false }],
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "org",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			const dl = await fx.app.request("/v1/download/acme/private-mod/v1.0.0", {
				headers: { "x-api-key": fx.keys.member },
			})
			expect(dl.status).toBe(404)
			expect(dl.headers.get("content-type")).toMatch(/application\/json/)
		})
	})

	describe("error shape consistency (VAL-PUB-019)", () => {
		it("every 401/403/404 from the download endpoint returns a JSON envelope with `error`", async () => {
			// 404 for missing version on a public module
			const r404a = await fx.app.request("/v1/download/acme/missing/0.0.0")
			expect(r404a.status).toBe(404)
			expect(r404a.headers.get("content-type")).toMatch(/application\/json/)
			const body404a = (await r404a.json()) as { error?: string }
			expect(typeof body404a.error).toBe("string")

			// 404 for org-visibility module without credential
			await git.commitManifest({
				name: "@acme/private-mod",
				version: "1.0.0",
				tag: "v1.0.0",
			})
			const pub = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "org",
				}),
			})
			const { versionId } = (await pub.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const r404b = await fx.app.request("/v1/download/acme/private-mod/v1.0.0")
			expect(r404b.status).toBe(404)
			expect(r404b.headers.get("content-type")).toMatch(/application\/json/)
			const body404b = (await r404b.json()) as { error?: string }
			expect(typeof body404b.error).toBe("string")
		})
	})
})
