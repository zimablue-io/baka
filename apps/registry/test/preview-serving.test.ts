import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Preview generation + serving (architecture §4.6 dry-run surface,
 * decision 31, VAL-SCAN-004 / 005 / 012 / 019, VAL-CROSS-020).
 *
 * The registry records per-recipe dry-run outcomes in
 * `screening_previews` (one row per (version_id, recipe_id)) and
 * surfaces them through:
 *
 *   GET /v1/packs/:scope/:name/:version/previews
 *     — list (recipe ids + states + file metadata)
 *
 *   GET /v1/packs/:scope/:name/:version/previews/:recipeId
 *     — single-recipe detail (file CONTENTS for `rendered`,
 *       needs-llm reason for that state)
 *
 * Visibility (architecture §8 decision 23, VAL-SCAN-019):
 *   - `public` packs: previews are served WITHOUT authentication.
 *     The landing site depends on this (its catalog is unauthenticated
 *     by design — the read surface for the catalog must agree).
 *   - `org` packs: previews follow the same membership gate as
 *     detail / version-detail / download. Outsiders (anonymous or
 *     authenticated-but-not-a-member) get the uniform 404 the
 *     detail endpoint returns; existence is not leaked.
 *
 * Determinism (VAL-CROSS-020): publishing the same pack content
 * at two tags (or two scopes) produces byte-identical preview
 * content. The storage adapter is content-addressed (sha256 = key)
 * so identical bytes are stored once and served identically; the
 * per-recipe `files[].contentHash` matches across publishes.
 */

interface TestStack {
	fx: IngestTestStack
	git: GitFixture
}

async function setupStack(): Promise<TestStack> {
	const fx = await buildIngestTestStack()
	const git = await createGitFixture()
	return { fx, git }
}

async function teardownStack({ fx, git }: TestStack): Promise<void> {
	await fx.close()
	await git.cleanup()
}

/**
 * Walks the response JSON for a single recipe's preview. The list
 * endpoint returns `{previews: [{recipeId, state, files?}]}` and
 * the detail endpoint returns `{recipeId, state, files?, reason?}`
 * — both shapes carry `files` keyed by `path`.
 */
function findPreview<T extends { recipeId: string }>(previews: T[], recipeId: string): T | undefined {
	return previews.find((p) => p.recipeId === recipeId)
}

/** Compute the sha256 hex digest of a string (for content comparison). */
function sha256Hex(content: string): string {
	return createHash("sha256").update(content).digest("hex")
}

describe("preview serving (VAL-SCAN-004 / 005 / 012 / 019)", () => {
	let stack: TestStack

	beforeEach(async () => {
		stack = await setupStack()
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	describe("rendered preview content (VAL-SCAN-004)", () => {
		it("the per-recipe endpoint returns the recipe's file contents and matches what the recipe actually wrote", async () => {
			// Recipe writes two files with known content. The
			// /previews/:recipeId endpoint must serve both bytes
			// verbatim, including nested paths.
			const recipeBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("preview.txt", "hello-from-dry-run")
    writeFileSync("nested/inner.txt", "nested-content")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

			await stack.git.commitManifest({
				name: "@acme/clean",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "clean",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt", "nested"],
						body: recipeBody,
					},
				],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "clean",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			// Per-recipe detail — the file CONTENTS are surfaced,
			// not just the metadata.
			const detail = await stack.fx.app.request("/v1/packs/acme/clean/v1.0.0/previews/writer", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			expect(detail.status).toBe(200)
			const body = (await detail.json()) as {
				recipeId: string
				state: "rendered" | "needs-llm"
				files?: Array<{ path: string; content: string; size: number; sha256: string }>
			}
			expect(body.recipeId).toBe("writer")
			expect(body.state).toBe("rendered")
			expect(body.files).toBeDefined()

			const byPath = new Map((body.files ?? []).map((f) => [f.path, f] as const))
			const preview = byPath.get("preview.txt")
			const nested = byPath.get("nested/inner.txt")
			expect(preview?.content).toBe("hello-from-dry-run")
			expect(preview?.size).toBe(Buffer.byteLength("hello-from-dry-run", "utf8"))
			expect(preview?.sha256).toBe(sha256Hex("hello-from-dry-run"))
			expect(nested?.content).toBe("nested-content")
			expect(nested?.sha256).toBe(sha256Hex("nested-content"))
		})

		it("the list endpoint surfaces rendered preview metadata that matches the per-recipe endpoint", async () => {
			const recipeBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("preview.txt", "list-content")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
			await stack.git.commitManifest({
				name: "@acme/list",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "list-mod",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt"],
						body: recipeBody,
					},
				],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "list-mod",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			const listRes = await stack.fx.app.request("/v1/packs/acme/list/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const listBody = (await listRes.json()) as {
				previews: Array<{
					recipeId: string
					state: string
					files?: Array<{ path: string; size: number; sha256: string }>
				}>
			}
			const writer = findPreview(listBody.previews, "writer")
			expect(writer?.state).toBe("rendered")
			const listFile = writer?.files?.find((f) => f.path === "preview.txt")
			expect(listFile?.sha256).toBe(sha256Hex("list-content"))
			expect(listFile?.size).toBe(Buffer.byteLength("list-content", "utf8"))

			// The list's sha256 matches the detail endpoint's file
			// sha256 — both surface the SAME content hash for the
			// SAME recipe's file. The list carries metadata only
			// (path / size / sha256), the detail carries bytes.
			const detailRes = await stack.fx.app.request("/v1/packs/acme/list/v1.0.0/previews/writer", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const detailBody = (await detailRes.json()) as {
				state: string
				files?: Array<{ path: string; content: string; sha256: string }>
			}
			expect(detailBody.state).toBe("rendered")
			const detailFile = detailBody.files?.find((f) => f.path === "preview.txt")
			expect(detailFile?.sha256).toBe(listFile?.sha256)
			expect(detailFile?.content).toBe("list-content")
		})
	})

	describe("needs-llm preview state (VAL-SCAN-005)", () => {
		it("requiresReasoning recipes serve the needs-llm state with the documented reason", async () => {
			// One non-reasoning writer + one requiresReasoning recipe.
			// The needs-llm preview record must surface the reason
			// verbatim (the architecture's "first-class preview state"
			// for LLM-requiring recipes).
			const writerBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("preview.txt", "ok")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
			const reasoningBody = `
export default {
  name: "reason",
  role: 1,
  async execute() {
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

			await stack.git.commitManifest({
				name: "@acme/llm",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "llm",
				recipes: [
					{ id: "writer", description: "writer", filePatterns: ["preview.txt"], body: writerBody },
					{
						id: "reason",
						description: "reasoning recipe",
						filePatterns: [],
						requiresReasoning: true,
						body: reasoningBody,
					},
				],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "llm",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			// Per-recipe detail for the reasoning recipe returns
			// `needs-llm` state + the documented reason; no files
			// (the recipe was never executed).
			const detail = await stack.fx.app.request("/v1/packs/acme/llm/v1.0.0/previews/reason")
			expect(detail.status).toBe(200)
			const body = (await detail.json()) as {
				recipeId: string
				state: string
				reason?: string
				files?: unknown[]
			}
			expect(body.recipeId).toBe("reason")
			expect(body.state).toBe("needs-llm")
			expect(body.reason).toBe("recipe skipped because it requires LLM reasoning")
			expect(body.files).toBeUndefined()
		})
	})

	describe("preview list matches manifest recipe list (VAL-SCAN-012)", () => {
		it("every manifest recipe has exactly one preview record — no extras, none missing", async () => {
			// Three recipes: two non-reasoning writers + one
			// requiresReasoning. The manifest declares all three;
			// the /previews endpoint must surface exactly one record
			// per recipe, with state "rendered" for the writers and
			// "needs-llm" for the reasoning recipe.
			const writerBody = (label: string) => `
import { writeFileSync } from "node:fs"
export default {
  name: ${JSON.stringify(label)},
  role: 1,
  async execute() {
    writeFileSync("preview.txt", ${JSON.stringify(label)})
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
			const reasoningBody = `
export default {
  name: "reason",
  role: 1,
  async execute() {
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

			await stack.git.commitManifest({
				name: "@acme/multi",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "multi",
				recipes: [
					{
						id: "writer-a",
						description: "writer a",
						filePatterns: ["preview.txt"],
						body: writerBody("a"),
					},
					{
						id: "writer-b",
						description: "writer b",
						filePatterns: ["preview.txt"],
						body: writerBody("b"),
					},
					{
						id: "reason",
						description: "reasoning",
						filePatterns: [],
						requiresReasoning: true,
						body: reasoningBody,
					},
				],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "multi",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			const listRes = await stack.fx.app.request("/v1/packs/acme/multi/v1.0.0/previews")
			const listBody = (await listRes.json()) as {
				previews: Array<{ recipeId: string; state: string }>
			}

			// Set equality: the served recipeIds must equal the
			// manifest's recipe ids; each served state matches the
			// recipe's `requiresReasoning` declaration (the two
			// writers are `rendered`, `reason` is `needs-llm`).
			const servedRecipeIds = new Set(listBody.previews.map((p) => p.recipeId).sort())
			expect([...servedRecipeIds]).toEqual(["reason", "writer-a", "writer-b"])
			expect(findPreview(listBody.previews, "writer-a")?.state).toBe("rendered")
			expect(findPreview(listBody.previews, "writer-b")?.state).toBe("rendered")
			expect(findPreview(listBody.previews, "reason")?.state).toBe("needs-llm")
		})
	})

	describe("public previews served without authentication (VAL-SCAN-019)", () => {
		it("a public pack's previews are reachable with no credential", async () => {
			const recipeBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("preview.txt", "public-content")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
			await stack.git.commitManifest({
				name: "@acme/pub",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "pub",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt"],
						body: recipeBody,
					},
				],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "pub",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			// No `x-api-key`, no cookie — public preview is unauth.
			const listRes = await stack.fx.app.request("/v1/packs/acme/pub/v1.0.0/previews")
			expect(listRes.status).toBe(200)
			const listBody = (await listRes.json()) as { previews: Array<{ recipeId: string }> }
			expect(listBody.previews.length).toBe(1)
			expect(listBody.previews[0]?.recipeId).toBe("writer")

			// Per-recipe detail is also unauth for public packs.
			const detailRes = await stack.fx.app.request("/v1/packs/acme/pub/v1.0.0/previews/writer")
			expect(detailRes.status).toBe(200)
			const detailBody = (await detailRes.json()) as {
				state: string
				files?: Array<{ path: string; content: string }>
			}
			expect(detailBody.state).toBe("rendered")
			expect(detailBody.files?.[0]?.content).toBe("public-content")
		})

		it("org-visibility previews are filtered by the same uniform 404 envelope as a missing pack", async () => {
			// Same fixture, but published with visibility: "org".
			// Org-visibility packs skip screening entirely
			// (decision 30: "private by default"), so no preview
			// record exists. The visibility gate returns the
			// uniform "version not found" envelope for non-members
			// (VAL-AUTH-019: existence not leaked); proven members
			// see the "no preview record" envelope because the
			// screening pipeline intentionally skips org-visibility.
			// Both surfaces return 404 with HONEST but DIFFERENT
			// bodies — outsiders cannot tell "not a member" from
			// "no preview was generated" by reading the response.
			const recipeBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("preview.txt", "private-content")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
			await stack.git.commitManifest({
				name: "@acme/priv",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "priv",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt"],
						body: recipeBody,
					},
				],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					packPath: "priv",
					// Default `org` visibility omitted explicitly:
					// the publish endpoint defaults visibility to
					// `org` when the field is absent.
				}),
			})
			expect(res.status).toBe(202)
			const body = (await res.json()) as { scope?: string; name?: string; versionId: string }
			expect(body.scope).toBe("acme")
			expect(body.name).toBe("priv")
			const { versionId } = body
			await stack.fx.waitForTerminal(versionId)

			// DB sanity: the pack row exists under scope=acme,
			// name=priv so the visibility gate's SELECT has
			// something to find.
			const dbPack = await stack.fx.pglite.query<{ scope: string; name: string; visibility: string }>(
				`SELECT scope, name, visibility FROM packs WHERE scope = 'acme' AND name = 'priv'`,
			)
			expect(dbPack.rows.length).toBe(1)
			expect(dbPack.rows[0]?.visibility).toBe("org")

			// No credential — uniform 404 (the same envelope as a
			// missing pack — visibility gate).
			const listRes = await stack.fx.app.request("/v1/packs/acme/priv/v1.0.0/previews")
			expect(listRes.status).toBe(404)
			const detailRes = await stack.fx.app.request("/v1/packs/acme/priv/v1.0.0/previews/writer")
			expect(detailRes.status).toBe(404)

			// Outsider (authenticated but NOT a member of acme) — same
			// uniform 404 (existence not leaked).
			const outsiderListRes = await stack.fx.app.request("/v1/packs/acme/priv/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.outsider },
			})
			expect(outsiderListRes.status).toBe(404)
			const outsiderDetailRes = await stack.fx.app.request("/v1/packs/acme/priv/v1.0.0/previews/writer", {
				headers: { "x-api-key": stack.fx.keys.outsider },
			})
			expect(outsiderDetailRes.status).toBe(404)

			// Member of acme — passes the visibility gate, so the
			// list endpoint returns 200 with an empty `previews`
			// array (screening skipped org-visibility, no records
			// were generated). The detail endpoint returns 404 with
			// the "no preview record" body — a different envelope
			// than the visibility-gate 404 above, so a member can
			// tell "this org-visibility pack never produced a
			// preview" from "I'm not a member".
			const memberListRes = await stack.fx.app.request("/v1/packs/acme/priv/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.member },
			})
			expect(memberListRes.status).toBe(200)
			const memberListBody = (await memberListRes.json()) as { previews: unknown[] }
			expect(memberListBody.previews).toEqual([])
			const memberDetailRes = await stack.fx.app.request("/v1/packs/acme/priv/v1.0.0/previews/writer", {
				headers: { "x-api-key": stack.fx.keys.member },
			})
			expect(memberDetailRes.status).toBe(404)
			const memberDetailBody = (await memberDetailRes.json()) as { error?: string }
			expect(memberDetailBody.error).toContain("no preview record")
		})
	})

	describe("unknown recipe returns 404", () => {
		it("the per-recipe endpoint returns 404 for a recipe the pack does not declare", async () => {
			const recipeBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("preview.txt", "ok")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`
			await stack.git.commitManifest({
				name: "@acme/one",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "one",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt"],
						body: recipeBody,
					},
				],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "one",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			const unknownRes = await stack.fx.app.request("/v1/packs/acme/one/v1.0.0/previews/does-not-exist")
			expect(unknownRes.status).toBe(404)
		})
	})
})

describe("preview determinism (VAL-CROSS-020)", () => {
	let stack: TestStack

	beforeEach(async () => {
		stack = await setupStack()
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	it("two tags of the same pack tree yield byte-identical preview content + identical content_hash", async () => {
		// Publish v1.0.0 then v1.0.1 from the SAME pack tree.
		// The two commits differ (the fixture bumps a tag-only
		// ref), but the recipe tree is byte-equal. The dry-run
		// output is therefore byte-equal: every preview file has
		// the same sha256 in `screening_previews.files[]`, and the
		// storage adapter's content-addressed dedup means the
		// bytes served are the SAME bytes (single blob on disk).
		const recipeBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("preview.txt", "deterministic-content")
    writeFileSync("nested/file.txt", "nested-deterministic")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

		// First tag — v1.0.0
		await stack.git.commitManifest({
			name: "@acme/det",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "det",
			recipes: [
				{
					id: "writer",
					description: "writer",
					filePatterns: ["preview.txt", "nested"],
					body: recipeBody,
				},
			],
		})

		const publish1 = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				packPath: "det",
			}),
		})
		const { versionId: versionId1 } = (await publish1.json()) as { versionId: string }
		const terminal1 = await stack.fx.waitForTerminal(versionId1)
		expect(terminal1.status).toBe("ready")

		// Second tag — v1.0.1 from the same pack tree. The
		// fixture's `commitManifest` writes the SAME pack tree
		// (different commit sha but identical recipe.ts bytes);
		// the publish endpoint only allows a manifest `version`
		// matching the tag, so we bump the version string here to
		// match the new tag.
		await stack.git.commitManifest({
			name: "@acme/det",
			version: "1.0.1",
			tag: "v1.0.1",
			packPath: "det",
			recipes: [
				{
					id: "writer",
					description: "writer",
					filePatterns: ["preview.txt", "nested"],
					body: recipeBody,
				},
			],
		})

		const publish2 = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.1",
				org: "acme",
				visibility: "public",
				packPath: "det",
			}),
		})
		const { versionId: versionId2 } = (await publish2.json()) as { versionId: string }
		const terminal2 = await stack.fx.waitForTerminal(versionId2)
		expect(terminal2.status).toBe("ready")

		// Content hashes are EQUAL across versions (same pack
		// tree → same packed tarball → same content hash).
		expect(terminal1.contentHash).toBe(terminal2.contentHash)
		expect(terminal1.contentHash).not.toBe("")

		// Version 1: list endpoint carries the sha256s of every
		// rendered file. Record them for cross-version equality.
		const list1Res = await stack.fx.app.request("/v1/packs/acme/det/v1.0.0/previews", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const list1 = (await list1Res.json()) as {
			previews: Array<{
				recipeId: string
				state: string
				files?: Array<{ path: string; sha256: string }>
			}>
		}
		const detail1Res = await stack.fx.app.request("/v1/packs/acme/det/v1.0.0/previews/writer", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const detail1 = (await detail1Res.json()) as {
			files?: Array<{ path: string; content: string; sha256: string }>
		}

		// Version 2: identical preview records.
		const list2Res = await stack.fx.app.request("/v1/packs/acme/det/v1.0.1/previews", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const list2 = (await list2Res.json()) as {
			previews: Array<{
				recipeId: string
				state: string
				files?: Array<{ path: string; sha256: string }>
			}>
		}
		const detail2Res = await stack.fx.app.request("/v1/packs/acme/det/v1.0.1/previews/writer", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const detail2 = (await detail2Res.json()) as {
			files?: Array<{ path: string; content: string; sha256: string }>
		}

		// Set comparison: same recipe ids, same per-file sha256s,
		// same state — modulo the natural ordering of jsonb
		// columns (the rows are sorted by path in the response).
		expect(list1.previews.length).toBe(list2.previews.length)
		expect(list1.previews[0]?.recipeId).toBe(list2.previews[0]?.recipeId)
		expect(list1.previews[0]?.state).toBe(list2.previews[0]?.state)
		const files1 = (list1.previews[0]?.files ?? []).map((f) => f.sha256).sort()
		const files2 = (list2.previews[0]?.files ?? []).map((f) => f.sha256).sort()
		expect(files1).toEqual(files2)

		// Detail endpoint bytes: identical content per file.
		const contents1 = (detail1.files ?? []).map((f) => f.content).sort()
		const contents2 = (detail2.files ?? []).map((f) => f.content).sort()
		expect(contents1).toEqual(contents2)
		expect(contents1).toEqual(["deterministic-content", "nested-deterministic"])
	})
})
