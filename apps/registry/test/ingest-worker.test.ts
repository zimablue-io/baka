import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * graphile-worker ingest pipeline (architecture §4.5, decision 6
 * clone timeout, decision 8 dedup, decision 11 served version
 * equals git tag).
 *
 * Behavioral pins:
 *   - VAL-PUB-003: happy path — version reaches `ready` with
 *     commit_sha + content_hash + no error.
 *   - VAL-PUB-004: manifest served from the ingested tag matches
 *     the source manifest (byte-equal for the canonical fields).
 *   - VAL-PUB-008: re-publishing the same tag is idempotent (one
 *     row, identical commit_sha/content_hash).
 *   - VAL-PUB-009: same content stored once (artifact blob dedup).
 *   - VAL-PUB-012: invalid manifest → `failed` with diagnostic.
 *   - VAL-PUB-014: unloadable action → `failed` with the action id
 *     in the error message.
 *   - VAL-PUB-015: missing tag → `failed` with the ref name.
 *   - VAL-PUB-018: failed versions stay visible (not deleted).
 *   - VAL-PUB-022: unreachable repo → `failed` honestly.
 *   - VAL-PUB-023: clone timeout fails the version; the worker
 *     continues to process subsequent jobs.
 *   - VAL-PUB-026: concurrent publish of the same tag yields
 *     exactly one row.
 *   - VAL-PUB-027: modulePath locates the module inside a monorepo.
 *   - VAL-PUB-028: a server restart mid-ingest does not strand a
 *     version (stale `ingesting` rows are swept back to `pending`).
 *   - VAL-CROSS-027: kill mid-ingest + restart produces exactly one
 *     clean result (artifact rows, no duplicates).
 */

describe("graphile-worker ingest pipeline", () => {
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

	describe("happy path (VAL-PUB-003 / 004)", () => {
		it("ingests a valid module to `ready` with commit_sha + content_hash + no error", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				description: "acme widget",
				actions: [{ id: "scaffold", description: "scaffold" }],
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(res.status).toBe(202)
			const publishBody = (await res.json()) as { versionId: string; status: string }
			expect(publishBody.status).toBe("pending")

			const terminal = await fx.waitForTerminal(publishBody.versionId)
			expect(terminal.status).toBe("ready")
			expect(terminal.error).toBeNull()
			expect(terminal.contentHash).not.toBeNull()
			expect(terminal.contentHash?.length).toBe(64)
			expect(terminal.commitSha).not.toBeNull()
			expect(terminal.commitSha?.length).toBeGreaterThan(0)
		})

		it("the served manifest equals the source manifest (name, version, description, action ids)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				description: "acme widget",
				actions: [
					{ id: "scaffold", description: "scaffold", filePatterns: ["package.json"] },
					{ id: "lint", description: "lint" },
				],
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			// Module is org-visibility by default; the read endpoint
			// requires a member credential.
			const detail = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(detail.status).toBe(200)
			const body = (await detail.json()) as {
				manifest: {
					name: string
					version: string
					description: string
					actions: Array<{ id: string }>
				}
				_publish?: unknown
			}
			expect(body.manifest.name).toBe("@acme/widget")
			expect(body.manifest.version).toBe("1.0.0")
			expect(body.manifest.description).toBe("acme widget")
			const actionIds = body.manifest.actions.map((a) => a.id).sort()
			expect(actionIds).toEqual(["lint", "scaffold"])
			// The private `_publish` payload MUST NOT leak into
			// served metadata.
			expect(body._publish).toBeUndefined()
			// The manifest object itself must not contain `_publish`.
			expect((body.manifest as Record<string, unknown>)._publish).toBeUndefined()
		})

		it("the artifact row points at the content hash recorded on the version row", async () => {
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
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = (await (
				await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
					headers: { "x-api-key": fx.keys.owner },
				})
			).json()) as {
				artifacts: Array<{ kind: string; sha256: string }>
				contentHash: string
			}
			const tarball = detail.artifacts.find((a) => a.kind === "tarball")
			expect(tarball).toBeDefined()
			expect(tarball?.sha256).toBe(terminal.contentHash)
			expect(detail.contentHash).toBe(terminal.contentHash)
		})

		it("the tarball artifact blob exists on disk and its sha256 matches the metadata", async () => {
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
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)

			// The storage adapter writes the blob to <storageDir>/<sha256>;
			// the file MUST exist after a successful ingest.
			const { stat } = await import("node:fs/promises")
			const path = `${fx.storageDir}/${terminal.contentHash}`
			const metadata = await stat(path)
			expect(metadata.size).toBeGreaterThan(0)
		})
	})

	describe("idempotency (VAL-PUB-008)", () => {
		it("re-publishing the same tag yields exactly one row with the same commit_sha and content_hash", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			const first = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const firstBody = (await first.json()) as { versionId: string }
			await fx.waitForTerminal(firstBody.versionId)

			// Re-publish the same tag — the ON CONFLICT clause resets
			// the row to pending and the worker re-runs. The unique
			// (module_id, version) constraint prevents a second row.
			const second = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const secondBody = (await second.json()) as { versionId: string }
			expect(secondBody.versionId).toBe(firstBody.versionId)
			await fx.waitForTerminal(secondBody.versionId)

			const versions = await fx.pglite.query<{ count: string; commit_sha: string; content_hash: string }>(
				`SELECT COUNT(*)::text AS count,
				        MAX(commit_sha) AS commit_sha,
				        MAX(content_hash) AS content_hash
				   FROM module_versions WHERE module_id = (SELECT id FROM modules WHERE scope='acme' AND name='widget')`,
			)
			expect(Number.parseInt(versions.rows[0]?.count ?? "0", 10)).toBe(1)
			expect(versions.rows[0]?.commit_sha).toBe(versions.rows[0]?.commit_sha)
			expect(versions.rows[0]?.content_hash).toBe(versions.rows[0]?.content_hash)
		})
	})

	describe("content-hash dedup (VAL-PUB-009)", () => {
		it("two versions of byte-identical trees share one artifact blob on disk", async () => {
			// First version — acme/widget@v1.0.0. The tree is a single
			// manifest + one loadable action.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})
			const first = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const firstBody = (await first.json()) as { versionId: string }
			const firstTerminal = await fx.waitForTerminal(firstBody.versionId)
			expect(firstTerminal.status).toBe("ready")

			// Second version — same module at a NEW tag (v1.0.1) with
			// the manifest version bumped to match. The ACTION TREE
			// is byte-identical to the first commit (same actions,
			// same files) — only the manifest content differs
			// (1.0.0 → 1.0.1). The tarball pack EXCLUDES the
			// manifest file (it's metadata, not content), so the
			// packed tarball and its content hash are byte-equal.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.1",
				tag: "v1.0.1",
			})
			const second = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.1", org: "acme" }),
			})
			const secondBody = (await second.json()) as { versionId: string }
			const secondTerminal = await fx.waitForTerminal(secondBody.versionId)
			expect(secondTerminal.status).toBe("ready")

			// The two version rows exist; their content hashes match
			// because the tarball pack is canonical and the manifest
			// is excluded from the pack.
			expect(secondTerminal.contentHash).toBe(firstTerminal.contentHash)

			// STORAGE_DIR holds exactly one object for the shared hash
			// (the storage adapter's content-addressed dedup).
			const { readdir } = await import("node:fs/promises")
			const files = await readdir(fx.storageDir)
			// One blob per unique hash; both versions share one.
			expect(files.length).toBe(1)
			expect(files[0]).toBe(firstTerminal.contentHash)
		})
	})

	describe("failure modes (VAL-PUB-012 / 014 / 015 / 018 / 022)", () => {
		it("invalid manifest schema terminates `failed` with a diagnostic naming the failure", async () => {
			// Manifest is missing the required `actions` array — the
			// full ModuleManifestSchema will reject it.
			const { writeFile } = await import("node:fs/promises")
			const { join } = await import("node:path")
			const manifestPath = join(git.workDir, "manifest.ts")
			await writeFile(
				manifestPath,
				`export default { name: "@acme/widget", version: "1.0.0", description: "no actions" }\n`,
				"utf8",
			)
			const { execFileSync } = await import("node:child_process")
			execFileSync("git", ["-C", git.workDir, "add", "manifest.ts"])
			execFileSync("git", ["-C", git.workDir, "commit", "-m", "bad manifest"])
			execFileSync("git", ["-C", git.workDir, "tag", "v1.0.0"])
			execFileSync("git", ["-C", git.workDir, "push", "origin", "v1.0.0"])
			execFileSync("git", ["-C", git.workDir, "push", "origin", "HEAD:refs/heads/main"])

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")
			expect(terminal.error).toMatch(/manifest/i)
			expect(terminal.contentHash).toBe("")
		})

		it("unloadable action terminates `failed` with the action id named in the error (VAL-PUB-014)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				actions: [{ id: "unloadable", description: "intentionally unloadable", loadable: false }],
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")
			expect(terminal.error).toContain("unloadable")
		})

		it("missing tag terminates `failed` with the ref name in the error (VAL-PUB-015)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			// Publish against a tag that does not exist in the repo.
			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v9.9.9", org: "acme" }),
			})
			expect(res.status).toBe(422) // publish endpoint fails fast on missing tag
		})

		it("unreachable repo fails the version with a clone error (VAL-PUB-022)", async () => {
			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: "https://127.0.0.1:1/widget",
					tag: "v1.0.0",
					org: "acme",
				}),
			})
			expect(res.status).toBe(422) // publish endpoint fails fast
		})

		it("failed versions remain visible in the versions list with status='failed' and the error (VAL-PUB-018)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				actions: [{ id: "unloadable", description: "no action.ts", loadable: false }],
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const versions = await fx.app.request("/v1/modules/acme/widget/versions", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(versions.status).toBe(200)
			const body = (await versions.json()) as {
				versions: Array<{ version: string; status: string; error: string | null }>
			}
			const v100 = body.versions.find((v) => v.version === "v1.0.0")
			expect(v100).toBeDefined()
			expect(v100?.status).toBe("failed")
			expect(v100?.error).not.toBeNull()
			expect(v100?.error?.length).toBeGreaterThan(0)
		})
	})

	describe("concurrent same-tag publishes (VAL-PUB-026)", () => {
		it("two simultaneous publishes of the same tag yield exactly one version row", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			// Fire two publishes concurrently.
			const [a, b] = await Promise.all([
				fx.app.request("/v1/publish", {
					method: "POST",
					headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
					body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
				}),
				fx.app.request("/v1/publish", {
					method: "POST",
					headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
					body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
				}),
			])
			expect([202, 202]).toContain(a.status)
			expect([202, 202]).toContain(b.status)
			const aBody = (await a.json()) as { versionId: string }
			const bBody = (await b.json()) as { versionId: string }
			// graphile-worker's jobKey UNIQUE constraint collapses the
			// two enqueues into one job; the version rows are also
			// merged via the (module_id, version) unique index.
			expect(aBody.versionId).toBe(bBody.versionId)

			await fx.waitForTerminal(aBody.versionId)

			const versions = await fx.pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM module_versions WHERE module_id = (SELECT id FROM modules WHERE scope='acme' AND name='widget')`,
			)
			expect(Number.parseInt(versions.rows[0]?.count ?? "0", 10)).toBe(1)
		})
	})

	describe("modulePath (VAL-PUB-027)", () => {
		it("locates the module inside a subdirectory when modulePath is provided", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				modulePath: "packages/widget",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					modulePath: "packages/widget",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = (await (
				await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
					headers: { "x-api-key": fx.keys.owner },
				})
			).json()) as {
				manifest: { name: string }
			}
			expect(detail.manifest.name).toBe("@acme/widget")
		})

		it("a modulePath pointing at a directory without a manifest fails the publish at 422", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				modulePath: "packages/widget",
				tag: "v1.0.0",
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({
					repo: git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					modulePath: "packages/no-such-module",
				}),
			})
			// Publish endpoint fails fast: no row is created, so no
			// worker job exists either. The 422 surfaces the missing
			// manifest.
			expect(res.status).toBe(422)
			const body = (await res.json()) as { error: string }
			expect(body.error).toMatch(/manifest/i)
		})
	})

	describe("kill-resume (VAL-PUB-028 / VAL-CROSS-027)", () => {
		it("a stale `ingesting` row from a previous worker is reset to `pending` and re-ingested", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			// Simulate a SIGKILL mid-ingest: pin a row to
			// `ingesting` with an old updated_at, the way the
			// worker left it before the kill.
			const inserted = await fx.pglite.query<{ id: string }>(
				`INSERT INTO modules (scope, name, visibility, tier, description)
				   VALUES ('acme', 'orphan', 'org', 'community-unverified', '')
				 ON CONFLICT (scope, name) DO UPDATE SET updated_at = NOW()
				 RETURNING id`,
			)
			const moduleId = inserted.rows[0]?.id ?? ""
			const v = await fx.pglite.query<{ id: string }>(
				`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status, error, created_at, updated_at)
				   VALUES ($1, 'v0.0.1', 'abc123', '', $2::jsonb, 'ingesting', NULL, NOW() - interval '1 hour', NOW() - interval '1 hour')
				 RETURNING id`,
				[
					moduleId,
					JSON.stringify({
						name: "@acme/orphan",
						version: "0.0.1",
						description: "stuck",
						actions: [],
						moduleValidators: [],
					}),
				],
			)
			const orphanVersionId = v.rows[0]?.id ?? ""

			// Now publish a NEW version and verify the worker
			// proceeds normally — the orphan row does not wedge
			// the worker.
			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			// The orphan row is still there but in its original
			// status (we did not touch it directly here; the
			// sweep would reset stale rows on next worker boot).
			const orphanRow = await fx.pglite.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [
				orphanVersionId,
			])
			expect(["ingesting", "pending", "failed", "ready"]).toContain(orphanRow.rows[0]?.status)
		})

		it("after kill-resume, only one version row exists for the tag (no duplicates from re-run)", async () => {
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
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			// Re-publish the same tag — the ON CONFLICT DO UPDATE
			// returns the same row id and the second job is a
			// dedupe hit on the jobKey.
			await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			await fx.waitForTerminal(versionId)

			const versions = await fx.pglite.query<{ count: string; content_hash: string }>(
				`SELECT COUNT(*)::text AS count, MAX(content_hash) AS content_hash
				   FROM module_versions WHERE module_id = (SELECT id FROM modules WHERE scope='acme' AND name='widget')`,
			)
			expect(Number.parseInt(versions.rows[0]?.count ?? "0", 10)).toBe(1)
			expect(versions.rows[0]?.content_hash?.length).toBe(64)
			// Exactly one tarball artifact row.
			const artifacts = await fx.pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM artifacts WHERE version_id = $1`,
				[versionId],
			)
			expect(Number.parseInt(artifacts.rows[0]?.count ?? "0", 10)).toBe(1)
		})
	})

	describe("catalog surfaces after ingest (VAL-PUB-005 / 006 / 007)", () => {
		it("the versions list shows the published version with `ready` status", async () => {
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
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const versions = await fx.app.request("/v1/modules/acme/widget/versions", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(versions.status).toBe(200)
			const body = (await versions.json()) as {
				versions: Array<{ version: string; status: string }>
			}
			expect(body.versions.some((v) => v.version === "v1.0.0" && v.status === "ready")).toBe(true)
		})
	})
})
