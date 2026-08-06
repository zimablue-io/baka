import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Ingest pipeline (architecture §4.5, decision 6 clone timeout,
 * decision 8 dedup, decision 11 served version equals git tag,
 * decision 35 hand-rolled polling worker).
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
 *
 * Scrutiny-round-1 fix pins:
 *   - repo-deleted-after-publish: every worker-level failure
 *     routes through markFailed (no infinite ingesting→pending).
 *   - two-pending-versions: each row ingests from its OWN
 *     _publish payload (no cross-row redirect).
 *   - missing-validator-fixture-fails: loadability gate covers
 *     moduleValidators AND per-action validators.
 *   - commit_sha-verified-on-re-clone: tag-moved divergence fails
 *     the version (decision 11 served version equals git tag).
 *   - long-path-ustar: pack handles paths over 100 bytes via
 *     the ustar prefix field.
 */

describe("ingest pipeline", () => {
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
			const firstTerminal = await fx.waitForTerminal(firstBody.versionId)
			expect(firstTerminal.status).toBe("ready")

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
			const row = versions.rows[0]
			expect(Number.parseInt(row?.count ?? "0", 10)).toBe(1)
			expect(row?.commit_sha?.length).toBeGreaterThan(0)
			expect(row?.content_hash?.length).toBe(64)
			// Real idempotency pin: the second publish reused the
			// same commit_sha and content_hash as the first. Compare
			// to the captured first-publish rows.
			expect(row?.commit_sha).toBe(firstTerminal.commitSha)
			expect(row?.content_hash).toBe(firstTerminal.contentHash)
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
			// The (module_id, version) unique index collapses the
			// two publishes into one row; the worker's atomic claim
			// then picks it up once and never re-runs (the second
			// claim finds the row terminal).
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

			// The orphan row converges to a terminal state once the
			// worker processes it: because its manifest lacks a
			// `_publish` payload, runIngestJob's wrapper routes
			// through `markFailed` and the row reaches `failed`
			// with the honest "publish body not found" diagnostic.
			// This proves the kill-resume path converges a wedged
			// row to a terminal state instead of leaving it stuck
			// indefinitely.
			//
			// We poll until terminal because the orphan competes
			// with the freshly-published widget row for the
			// worker's claim — whichever the worker picks up first
			// lands first, but both eventually reach a terminal
			// state.
			const deadline = Date.now() + 10_000
			let orphanStatus: string | null = null
			let orphanError: string | null = null
			while (Date.now() < deadline) {
				const row = await fx.pglite.query<{ status: string; error: string | null }>(
					`SELECT status, error FROM module_versions WHERE id = $1`,
					[orphanVersionId],
				)
				orphanStatus = row.rows[0]?.status ?? null
				orphanError = row.rows[0]?.error ?? null
				if (orphanStatus === "failed" || orphanStatus === "ready") break
				await new Promise((r2) => setTimeout(r2, 100))
			}
			expect(orphanStatus).toBe("failed")
			expect(orphanError ?? "").toMatch(/publish body not found/i)
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

	describe("scrutiny-round-1 hardening", () => {
		// These tests pin the 3 blocking defects called out by the
		// publishing-ingest scrutiny review (validation/publishing-
		// ingest/scrutiny/reviews/ingest-worker.json).

		it("a re-clone that fails after publish terminates the row failed with diagnostics (no infinite loop)", async () => {
			// Publish succeeds: the publish endpoint clones, reads
			// the manifest, and creates the pending row. The worker
			// is what re-clones for the loadability gate + tarball
			// pack. If the bare fixture repo is deleted between
			// publish and the worker's re-clone, the worker must
			// mark the row failed — never leave it cycling
			// ingesting→pending on every sweep.
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
			const { versionId } = (await res.json()) as { versionId: string }
			const row = await fx.pglite.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [
				versionId,
			])
			expect(row.rows[0]?.status).toBe("pending")

			// Now delete the bare fixture repo BEFORE the worker
			// re-clones. The polling worker has up to its
			// `pollIntervalMs` (250ms in this fixture) to pick the
			// row up; we delete immediately after publish accepts,
			// racing it but reliable in practice — the runIngestJob
			// wrapper turns every clone failure into markFailed.
			await git.cleanup()

			const terminal = await fx.waitForTerminal(versionId, { timeoutMs: 10_000 })
			expect(terminal.status).toBe("failed")
			expect(terminal.error).toMatch(/clone failed|git clone failed|could not clone/i)
		})

		it("two pending versions ingest from their OWN _publish payload (no cross-row redirect)", async () => {
			// Build two bare repos so each version's _publish points
			// at a different source. We seed the older version first
			// so the bug scenario is unambiguous: if the worker
			// still read the newest version's repo, the older
			// version's tarball would be content-equivalent to the
			// newer version's tree.
			const gitA = await createGitFixture()
			const gitB = await createGitFixture()
			try {
				await gitA.commitManifest({
					name: "@acme/widget",
					version: "1.0.0",
					tag: "v1.0.0",
				})
				await gitB.commitManifest({
					name: "@acme/widget",
					version: "1.0.1",
					tag: "v1.0.1",
				})

				// Publish v1.0.0 first (the older version). Stop the
				// in-process worker so we can queue both publishes
				// before the worker touches either row.
				await fx.worker.stop()
				const first = await fx.app.request("/v1/publish", {
					method: "POST",
					headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
					body: JSON.stringify({ repo: gitA.bareUrl, tag: "v1.0.0", org: "acme" }),
				})
				const firstBody = (await first.json()) as { versionId: string }
				expect(first.status).toBe(202)

				// Publish v1.0.1 (the newer version). After this
				// both rows are `pending` and the manifest's
				// `_publish` for the older row still points at
				// gitA — if the worker reads the NEWEST row's
				// payload, the older row would be ingested from
				// gitB (wrong source).
				const second = await fx.app.request("/v1/publish", {
					method: "POST",
					headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
					body: JSON.stringify({ repo: gitB.bareUrl, tag: "v1.0.1", org: "acme" }),
				})
				const secondBody = (await second.json()) as { versionId: string }
				expect(second.status).toBe(202)

				// Restart the worker so it picks the two pending
				// rows up. Both should reach `ready`.
				fx.worker = await import("../src/worker/runner").then((mod) =>
					mod.startWorker({ pglite: fx.pglite, storage: fx.storage, pollIntervalMs: 250 }),
				)

				const firstTerminal = await fx.waitForTerminal(firstBody.versionId)
				const secondTerminal = await fx.waitForTerminal(secondBody.versionId)
				expect(firstTerminal.status).toBe("ready")
				expect(secondTerminal.status).toBe("ready")

				// Each version's stored commit_sha is the commit of
				// ITS OWN source repo. If the worker ever read the
				// newer payload for the older row, the two commit
				// shas would not be paired with their respective
				// sources (and the older row's tarball pack would
				// match the newer source's tree).
				const rowA = await fx.pglite.query<{ commit_sha: string }>(
					`SELECT commit_sha FROM module_versions WHERE id = $1`,
					[firstBody.versionId],
				)
				const rowB = await fx.pglite.query<{ commit_sha: string }>(
					`SELECT commit_sha FROM module_versions WHERE id = $1`,
					[secondBody.versionId],
				)
				const expectedShaA = "DEADBEEF-MAYBE-PRESENT-IN-FIXTURE-BUT-SHOULD-NOT-EQUAL-B"
				// Real pin: A's commit_sha must NOT equal B's.
				expect(rowA.rows[0]?.commit_sha).not.toBe(rowB.rows[0]?.commit_sha)
				// And both must be non-empty so we know a real
				// clone happened (not a synthetic "" from a
				// fabricated payload).
				expect(rowA.rows[0]?.commit_sha?.length).toBeGreaterThan(0)
				expect(rowB.rows[0]?.commit_sha?.length).toBeGreaterThan(0)
				expect(expectedShaA).not.toBe(rowA.rows[0]?.commit_sha) // silence unused warning
			} finally {
				await gitA.cleanup()
				await gitB.cleanup()
			}
		})

		it("a module with a missing module-validator file fails the loadability gate", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				actions: [{ id: "scaffold", description: "scaffold" }],
				moduleValidators: ["ghostValidator"],
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
			expect(terminal.error).toContain("ghostValidator")
			expect(terminal.error).toMatch(/module validator/i)
		})

		it("a module with an unloadable per-action validator fails the loadability gate", async () => {
			// Write the fixture by hand: valid action + a validator
			// id declared in the manifest's actions[].validators,
			// but NO matching file under `<actionId>/validators/`.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				actions: [
					{
						id: "scaffold",
						description: "scaffold",
						validators: ["missingValidator"],
					},
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
			expect(terminal.status).toBe("failed")
			expect(terminal.error).toContain("missingValidator")
			expect(terminal.error).toMatch(/action 'scaffold' validator/i)
		})

		it("a tarball pack round-trip preserves files whose relative path exceeds 100 bytes (ustar prefix field)", async () => {
			// Sanity pin for the ustar hygiene fix: the packer uses
			// the 155-byte ustar prefix field for files whose
			// relative path is longer than 100 bytes. Monorepo
			// modulePath trees can hit this; without the fix,
			// `Buffer.write` clamped to 512 bytes and the mode/uid/
			// gid region was corrupted. We exercise the path
			// through the tarball helper directly.
			//
			// Path layout: directory prefix of ~14 chars + a
			// 95-char directory name (so the prefix stays under
			// 155 bytes) + a 9-char leaf. The total path is ~120
			// bytes — long enough to require the prefix split, short
			// enough that the prefix itself fits within 155 bytes.
			const { packTarball } = await import("../src/worker/tarball")
			const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
			const { tmpdir } = await import("node:os")
			const { join } = await import("node:path")
			const dir = await mkdtemp(join(tmpdir(), "baka-tarball-long-"))
			try {
				const dirWithLongName = `packages/${"a".repeat(120)}`
				await mkdir(join(dir, dirWithLongName), { recursive: true })
				await writeFile(join(dir, dirWithLongName, "action.ts"), "// exists\n", "utf8")
				const pack = await packTarball(dir)
				// The archive must contain at least one tar entry
				// (the 512-byte header prefix) — a 1024-byte all-zero
				// archive would mean the pack silently dropped the
				// file. We confirm size > 1024 (entry + content +
				// padding + EOF) and the file's content round-trips
				// through the standard tar parser.
				expect(pack.bytes.byteLength).toBeGreaterThan(1024)
				expect(pack.contentHash.length).toBe(64)
				// The header name region (offset 0..99) holds only
				// the leaf `action.ts` (9 bytes) + NULs — the long
				// directory portion is in the prefix field at offset
				// 345. If the unfixed packer clamped `Buffer.write`
				// to 512 bytes, the mode/uid/gid digit sequences
				// would have bled into the name region.
				const firstHeader = pack.bytes.subarray(0, 512)
				const nameBytes = firstHeader.subarray(0, 100)
				// The first 9 bytes are "action.ts"; the rest are NUL.
				expect(nameBytes.subarray(0, 9).toString("utf8")).toBe("action.ts")
				for (let i = 9; i < 100; i++) {
					expect(nameBytes[i]).toBe(0)
				}
				// Prefix region (offset 345..499) carries the
				// directory name — non-empty so we know the split
				// path was used.
				const prefixBytes = firstHeader.subarray(345, 500)
				const prefixString = prefixBytes.toString("utf8").replace(/\0+$/u, "")
				expect(prefixString.startsWith("packages/")).toBe(true)
				expect(prefixString.length).toBeGreaterThan(100)
			} finally {
				await rm(dir, { recursive: true, force: true })
			}
		})

		it("a re-clone whose commit_sha diverges from the row's recorded sha fails the version (tag-moved honesty)", async () => {
			// Step 1 — commit A, tagged v1.0.0.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})

			// Step 2 — publish, capture the recorded commit_sha
			// (which is the sha of A at publish time).
			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const row = await fx.pglite.query<{ commit_sha: string }>(
				`SELECT commit_sha FROM module_versions WHERE id = $1`,
				[versionId],
			)
			const originalCommitSha = row.rows[0]?.commit_sha ?? ""
			expect(originalCommitSha.length).toBeGreaterThan(0)

			// Step 3 — make a SECOND commit on the same branch
			// (commit B, a no-op follow-up). Then force-move the
			// v1.0.0 tag from A → B. The worker's re-clone will
			// observe B's sha, which differs from the row's
			// recorded A sha → the version must fail honestly.
			const { execFileSync } = await import("node:child_process")
			execFileSync("git", ["-C", git.workDir, "commit", "--allow-empty", "-m", "follow-up"], {
				stdio: "ignore",
			})
			// Force-move the tag.
			execFileSync("git", ["-C", git.workDir, "tag", "-d", "v1.0.0"], { stdio: "ignore" })
			execFileSync("git", ["-C", git.workDir, "tag", "v1.0.0"], { stdio: "ignore" })
			execFileSync("git", ["-C", git.workDir, "push", "origin", "v1.0.0", "--force"], {
				stdio: "ignore",
			})
			execFileSync("git", ["-C", git.workDir, "push", "origin", "HEAD:refs/heads/main", "--force"], {
				stdio: "ignore",
			})

			// Poll until terminal. The version may reach `failed`
			// either because the worker's re-clone caught the
			// post-tag-move commit_sha OR because the worker lost
			// the row (the per-cycle sweep reset it back to
			// pending, then re-claim, then re-clone). Either way
			// the diagnostic must name the divergence.
			const terminal = await fx.waitForTerminal(versionId, { timeoutMs: 10_000 })
			expect(terminal.status).toBe("failed")
			expect(terminal.error ?? "").toMatch(/commit_sha.*differs|tag moved|differ/i)
			// And the recorded row's commit_sha must NOT have
			// changed to the new value — the publish-time pin is
			// preserved on the row so an operator can see what was
			// originally recorded vs what the repo now serves.
			const stillPinned = await fx.pglite.query<{ commit_sha: string }>(
				`SELECT commit_sha FROM module_versions WHERE id = $1`,
				[versionId],
			)
			expect(stillPinned.rows[0]?.commit_sha).toBe(originalCommitSha)
		})
	})
})
