import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Ready-version immutability + re-publish semantics + served
 * manifest defaults (architecture §8 decisions 37-38; user-testing
 * round 1 outcomes VAL-CROSS-004, VAL-PUB-008, VAL-PUB-004).
 *
 * Three behaviors pinned here:
 *
 *   1. VAL-CROSS-004 (force-moved tag over a ready version):
 *      when the resolved commit at the SAME tag differs from the
 *      recorded READY version's commit_sha, the publish endpoint
 *      returns 409 with a JSON error naming the immutability
 *      violation AND both commit shas. The original ready row's
 *      commit_sha/content_hash/artifact blob are NOT overwritten.
 *
 *   2. VAL-PUB-008 (same-commit re-publish of a ready version):
 *      re-publishing the same `repo@tag` against an already-ready
 *      version with the SAME resolved commit returns an idempotent
 *      200 (the contract's "200 with the same record") with the
 *      existing versionId — the polling worker is NOT signaled, so
 *      the row stays `ready` with the original commit_sha and
 *      content_hash. Non-ready rows (failed/pending/ingesting) still
 *      accept the 202 re-ingest path.
 *
 *   3. VAL-PUB-004 (served manifest defaults): the manifest served
 *      at `GET /v1/packs/:scope/:name/:version` round-trips
 *      through `PackManifestSchema` — every recipe's
 *      `filePatterns` (and other defaulted fields like `validators`,
 *      `dependencies`, `conflictsWith`, `packValidators`) is
 *      present in the served JSON, even when the source declared
 *      an empty array. The fix lives at the read surface (the
 *      catalog route applies schema defaults before stripping
 *      `_publish`) so it covers both publish-time and any future
 *      ingestion paths without each one re-implementing defaults.
 *
 * These tests run against the full stack (real PGlite + real git
 * fixtures + the polling worker) so the immutability pin holds
 * end-to-end: the publish endpoint rejects the bad re-publish AND
 * the stored ready version continues to serve the original tarball.
 */

describe("version immutability + re-publish semantics + served manifest defaults", () => {
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

	// -------------------------------------------------------------------------
	// VAL-CROSS-004 — force-moved tag over a ready version
	// -------------------------------------------------------------------------

	describe("VAL-CROSS-004: force-moved tag over a ready version is rejected (no overwrite)", () => {
		it("returns 409-class error naming the immutability violation AND both commit shas when the tag is force-moved", async () => {
			// Step 1 — commit A at v1.0.0, publish, wait for ready.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
				description: "original",
			})
			const firstRes = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(firstRes.status).toBe(202)
			const firstBody = (await firstRes.json()) as { versionId: string }
			const firstTerminal = await fx.waitForTerminal(firstBody.versionId)
			expect(firstTerminal.status).toBe("ready")
			const originalCommitSha = firstTerminal.commitSha ?? ""
			const originalContentHash = firstTerminal.contentHash ?? ""
			expect(originalCommitSha.length).toBeGreaterThan(0)
			expect(originalContentHash.length).toBe(64)

			// Step 2 — capture the served tarball bytes for the
			// original ready version. The download endpoint serves
			// the stored blob; the response body's sha256 must equal
			// the recorded content_hash (VAL-PUB-009).
			const originalDownload = await fx.app.request("/v1/download/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(originalDownload.status).toBe(200)
			const originalBytes = new Uint8Array(await originalDownload.arrayBuffer())
			expect(originalBytes.byteLength).toBeGreaterThan(0)

			// Step 3 — make a SECOND commit on the same branch
			// (commit B, a follow-up). Then force-move v1.0.0 from
			// A → B. The re-publish will see B's commit_sha which
			// differs from the row's recorded A sha.
			execFileSync("git", ["-C", git.workDir, "commit", "--allow-empty", "-m", "mutation"], {
				stdio: "ignore",
			})
			execFileSync("git", ["-C", git.workDir, "tag", "-d", "v1.0.0"], { stdio: "ignore" })
			execFileSync("git", ["-C", git.workDir, "tag", "v1.0.0"], { stdio: "ignore" })
			execFileSync("git", ["-C", git.workDir, "push", "origin", "v1.0.0", "--force"], {
				stdio: "ignore",
			})
			execFileSync("git", ["-C", git.workDir, "push", "origin", "HEAD:refs/heads/main", "--force"], {
				stdio: "ignore",
			})

			// Step 4 — re-publish the same {repo, tag, org}. The
			// publish endpoint MUST reject this with a 409-class
			// error naming the immutability violation AND both
			// commit shas (the recorded ready sha AND the freshly-
			// resolved sha). A 202 (the bug) would silently overwrite
			// the ready version.
			const secondRes = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect([409, 422]).toContain(secondRes.status)
			const secondBody = (await secondRes.json()) as {
				error?: string
				existingCommitSha?: string
				requestedCommitSha?: string
				versionId?: string
			}
			// The error message names BOTH shas (the contract's
			// "naming the immutability violation and both shas").
			expect((secondBody.error ?? "").toLowerCase()).toMatch(/immutab|version|v1\.0\.0/)
			expect(typeof secondBody.existingCommitSha).toBe("string")
			expect(typeof secondBody.requestedCommitSha).toBe("string")
			expect(secondBody.existingCommitSha).toBe(originalCommitSha)
			expect(secondBody.requestedCommitSha).not.toBe(originalCommitSha)
			expect(secondBody.requestedCommitSha?.length).toBeGreaterThan(0)

			// Step 5 — the original ready row's commit_sha,
			// content_hash, AND artifact blob are UNTOUCHED. The
			// pinned download still serves the ORIGINAL bytes.
			const row = await fx.pglite.query<{ commit_sha: string; content_hash: string; status: string }>(
				`SELECT commit_sha, content_hash, status FROM pack_versions WHERE id = $1`,
				[firstBody.versionId],
			)
			expect(row.rows[0]?.commit_sha).toBe(originalCommitSha)
			expect(row.rows[0]?.content_hash).toBe(originalContentHash)
			expect(row.rows[0]?.status).toBe("ready")

			// The tarball on disk is the ORIGINAL blob.
			const { stat } = await import("node:fs/promises")
			const blobPath = `${fx.storageDir}/${originalContentHash}`
			const blobStat = await stat(blobPath)
			expect(blobStat.size).toBeGreaterThan(0)

			// And the download endpoint still serves bytes that
			// hash to the original content_hash (the pinned
			// download surfaces the ORIGINAL tree, not the mutated
			// one — that's the entire point of the immutability
			// guarantee).
			const downloadAfter = await fx.app.request("/v1/download/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(downloadAfter.status).toBe(200)
			const downloadAfterBytes = new Uint8Array(await downloadAfter.arrayBuffer())
			expect(downloadAfterBytes.byteLength).toBe(originalBytes.byteLength)
			expect(downloadAfterBytes).toEqual(originalBytes)
		})

		it("the immutability 409 does NOT create a new pack_versions row", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})
			const firstRes = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await firstRes.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			// Force-move the tag.
			execFileSync("git", ["-C", git.workDir, "commit", "--allow-empty", "-m", "mutation"], {
				stdio: "ignore",
			})
			execFileSync("git", ["-C", git.workDir, "tag", "-d", "v1.0.0"], { stdio: "ignore" })
			execFileSync("git", ["-C", git.workDir, "tag", "v1.0.0"], { stdio: "ignore" })
			execFileSync("git", ["-C", git.workDir, "push", "origin", "v1.0.0", "--force"], {
				stdio: "ignore",
			})
			execFileSync("git", ["-C", git.workDir, "push", "origin", "HEAD:refs/heads/main", "--force"], {
				stdio: "ignore",
			})

			const beforeCount = await fx.pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM pack_versions WHERE pack_id = (SELECT id FROM packs WHERE scope='acme' AND name='widget')`,
			)
			await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const afterCount = await fx.pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM pack_versions WHERE pack_id = (SELECT id FROM packs WHERE scope='acme' AND name='widget')`,
			)
			expect(Number.parseInt(afterCount.rows[0]?.count ?? "0", 10)).toBe(
				Number.parseInt(beforeCount.rows[0]?.count ?? "0", 10),
			)
		})
	})

	// -------------------------------------------------------------------------
	// VAL-PUB-008 — same-commit re-publish of a ready version
	// -------------------------------------------------------------------------

	describe("VAL-PUB-008: same-commit re-publish of a ready version is idempotent (200, no re-ingest)", () => {
		it("returns 200 with the existing version record and DOES NOT enqueue a re-ingest when the commit is unchanged", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})
			const firstRes = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const firstBody = (await firstRes.json()) as { versionId: string }
			const firstTerminal = await fx.waitForTerminal(firstBody.versionId)
			expect(firstTerminal.status).toBe("ready")

			// Re-publish the same repo@tag with no tag-move. The
			// resolved commit_sha is identical to the recorded one.
			// Contract: idempotent 200 (with the same record) or 409
			// naming the existing version — NOT a 202 that re-ingests.
			const secondRes = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect([200, 409]).toContain(secondRes.status)
			const secondBody = (await secondRes.json()) as {
				versionId?: string
				scope?: string
				name?: string
				version?: string
				status?: string
				commitSha?: string
			}
			expect(secondBody.versionId).toBe(firstBody.versionId)
			expect(secondBody.status).toBe("ready")
			expect(secondBody.commitSha).toBe(firstTerminal.commitSha)

			// Critical pin: the row was NOT reset to pending by the
			// re-publish. It stays `ready` with the original
			// commit_sha and content_hash. If the contract regressed
			// to "202 re-ingest on re-publish", this row would be
			// cycling `ingesting` → `ready` and the timestamps would
			// have advanced.
			await new Promise((r) => setTimeout(r, 500))
			const row = await fx.pglite.query<{
				status: string
				commit_sha: string
				content_hash: string
				updated_at: Date
			}>(`SELECT status, commit_sha, content_hash, updated_at FROM pack_versions WHERE id = $1`, [firstBody.versionId])
			expect(row.rows[0]?.status).toBe("ready")
			expect(row.rows[0]?.commit_sha).toBe(firstTerminal.commitSha)
			expect(row.rows[0]?.content_hash).toBe(firstTerminal.contentHash)

			// And the worker didn't process a job for this versionId
			// a second time — there's still exactly one tarball
			// artifact row for the version.
			const artifactRows = await fx.pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM artifacts WHERE version_id = $1`,
				[firstBody.versionId],
			)
			expect(Number.parseInt(artifactRows.rows[0]?.count ?? "0", 10)).toBe(1)
		})

		it("non-ready rows (failed) still accept 202 re-ingest retries (the immutability carve-out)", async () => {
			// Manually mark a published version `failed` and re-publish
			// the same tag — the contract says 202 + re-ingest is
			// reserved for non-ready rows (failed/pending retry).
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
			})
			const firstRes = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await firstRes.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			// Simulate an operator-driven failure: set the row to
			// `failed` with a diagnostic. The re-publish MUST accept
			// this (202) and the worker MUST re-ingest to ready.
			await fx.pglite.query(`UPDATE pack_versions SET status = 'failed', error = 'simulated' WHERE id = $1`, [
				versionId,
			])

			const secondRes = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			expect(secondRes.status).toBe(202)
			const secondBody = (await secondRes.json()) as { versionId: string; status: string }
			expect(secondBody.versionId).toBe(versionId)

			// The worker re-ingests — wait for the row to come back
			// to a terminal state.
			const final = await fx.waitForTerminal(versionId)
			expect(final.status).toBe("ready")
		})
	})

	// -------------------------------------------------------------------------
	// VAL-PUB-004 — served manifest round-trips through the protocol schema
	// -------------------------------------------------------------------------

	describe("VAL-PUB-004: served manifest carries default fields (filePatterns:[] preserved)", () => {
		it("the served manifest includes filePatterns:[] on recipes whose source filePatterns is empty", async () => {
			// Publish a pack with one recipe that declares
			// `filePatterns: []` (the canonical empty-array case) and
			// one recipe that declares a non-empty filePatterns.
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
				recipes: [
					{ id: "noop", description: "no-op recipe", filePatterns: [], requiresReasoning: false },
					{
						id: "scaffold-lite",
						description: "scaffold lite",
						filePatterns: ["src/index.txt"],
						requiresReasoning: false,
					},
				],
			})
			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const detail = await fx.app.request("/v1/packs/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			expect(detail.status).toBe(200)
			const body = (await detail.json()) as {
				manifest: {
					name: string
					version: string
					description: string
					dependencies?: string[]
					conflictsWith?: string[]
					packValidators?: string[]
					recipes: Array<{
						id: string
						description: string
						filePatterns?: string[]
						validators?: string[]
						requiresReasoning: boolean
						params?: unknown[]
					}>
				}
			}

			// The manifest round-trips through PackManifestSchema.
			// Every defaulted field is present in the served JSON.
			expect(body.manifest.name).toBe("@acme/widget")
			expect(body.manifest.version).toBe("1.0.0")
			expect(Array.isArray(body.manifest.dependencies)).toBe(true)
			expect(body.manifest.dependencies).toEqual([])
			expect(Array.isArray(body.manifest.conflictsWith)).toBe(true)
			expect(body.manifest.conflictsWith).toEqual([])
			expect(Array.isArray(body.manifest.packValidators)).toBe(true)
			expect(body.manifest.packValidators).toEqual([])

			const noop = body.manifest.recipes.find((a) => a.id === "noop")
			expect(noop).toBeDefined()
			expect(Array.isArray(noop?.filePatterns)).toBe(true)
			expect(noop?.filePatterns).toEqual([])
			expect(Array.isArray(noop?.validators)).toBe(true)
			expect(noop?.validators).toEqual([])
			expect(Array.isArray(noop?.params)).toBe(true)

			const scaffold = body.manifest.recipes.find((a) => a.id === "scaffold-lite")
			expect(scaffold).toBeDefined()
			expect(scaffold?.filePatterns).toEqual(["src/index.txt"])
			expect(scaffold?.validators).toEqual([])
		})

		it("the served manifest re-parses cleanly through PackManifestSchema (round-trip)", async () => {
			// Import the schema dynamically to avoid a hard
			// workspace dependency from the test runner.
			const { PackManifestSchema } = await import("@repo/protocol")

			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
				recipes: [{ id: "noop", description: "no-op recipe", filePatterns: [], requiresReasoning: false }],
			})
			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await fx.waitForTerminal(versionId)

			const detail = await fx.app.request("/v1/packs/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			const body = (await detail.json()) as { manifest: unknown }
			const parsed = PackManifestSchema.safeParse(body.manifest)
			expect(parsed.success).toBe(true)
		})
	})
})
