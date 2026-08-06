import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Preview generation + serving (architecture §4.6 dry-run surface,
 * decision 31, VAL-SCAN-004 / 005 / 012 / 019, VAL-CROSS-020).
 *
 * The registry records per-action dry-run outcomes in
 * `screening_previews` (one row per (version_id, action_id)) and
 * surfaces them through:
 *
 *   GET /v1/modules/:scope/:name/:version/previews
 *     — list (action ids + states + file metadata)
 *
 *   GET /v1/modules/:scope/:name/:version/previews/:actionId
 *     — single-action detail (file CONTENTS for `rendered`,
 *       needs-llm reason for that state)
 *
 * Visibility (architecture §8 decision 23, VAL-SCAN-019):
 *   - `public` modules: previews are served WITHOUT authentication.
 *     The landing site depends on this (its catalog is unauthenticated
 *     by design — the read surface for the catalog must agree).
 *   - `org` modules: previews follow the same membership gate as
 *     detail / version-detail / download. Outsiders (anonymous or
 *     authenticated-but-not-a-member) get the uniform 404 the
 *     detail endpoint returns; existence is not leaked.
 *
 * Determinism (VAL-CROSS-020): publishing the same module content
 * at two tags (or two scopes) produces byte-identical preview
 * content. The storage adapter is content-addressed (sha256 = key)
 * so identical bytes are stored once and served identically; the
 * per-action `files[].contentHash` matches across publishes.
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
 * Walks the response JSON for a single action's preview. The list
 * endpoint returns `{previews: [{actionId, state, files?}]}` and
 * the detail endpoint returns `{actionId, state, files?, reason?}`
 * — both shapes carry `files` keyed by `path`.
 */
function findPreview<T extends { actionId: string }>(previews: T[], actionId: string): T | undefined {
	return previews.find((p) => p.actionId === actionId)
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
		it("the per-action endpoint returns the action's file contents and matches what the action actually wrote", async () => {
			// Action writes two files with known content. The
			// /previews/:actionId endpoint must serve both bytes
			// verbatim, including nested paths.
			const actionBody = `
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
				modulePath: "clean",
				actions: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt", "nested"],
						body: actionBody,
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
					modulePath: "clean",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			// Per-action detail — the file CONTENTS are surfaced,
			// not just the metadata.
			const detail = await stack.fx.app.request("/v1/modules/acme/clean/v1.0.0/previews/writer", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			expect(detail.status).toBe(200)
			const body = (await detail.json()) as {
				actionId: string
				state: "rendered" | "needs-llm"
				files?: Array<{ path: string; content: string; size: number; sha256: string }>
			}
			expect(body.actionId).toBe("writer")
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

		it("the list endpoint surfaces rendered preview metadata that matches the per-action endpoint", async () => {
			const actionBody = `
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
				modulePath: "list-mod",
				actions: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt"],
						body: actionBody,
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
					modulePath: "list-mod",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			const listRes = await stack.fx.app.request("/v1/modules/acme/list/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const listBody = (await listRes.json()) as {
				previews: Array<{
					actionId: string
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
			// SAME action's file. The list carries metadata only
			// (path / size / sha256), the detail carries bytes.
			const detailRes = await stack.fx.app.request("/v1/modules/acme/list/v1.0.0/previews/writer", {
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
		it("requiresReasoning actions serve the needs-llm state with the documented reason", async () => {
			// One non-reasoning writer + one requiresReasoning action.
			// The needs-llm preview record must surface the reason
			// verbatim (the architecture's "first-class preview state"
			// for LLM-requiring actions).
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
				modulePath: "llm",
				actions: [
					{ id: "writer", description: "writer", filePatterns: ["preview.txt"], body: writerBody },
					{
						id: "reason",
						description: "reasoning action",
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
					modulePath: "llm",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			// Per-action detail for the reasoning action returns
			// `needs-llm` state + the documented reason; no files
			// (the action was never executed).
			const detail = await stack.fx.app.request("/v1/modules/acme/llm/v1.0.0/previews/reason")
			expect(detail.status).toBe(200)
			const body = (await detail.json()) as {
				actionId: string
				state: string
				reason?: string
				files?: unknown[]
			}
			expect(body.actionId).toBe("reason")
			expect(body.state).toBe("needs-llm")
			expect(body.reason).toBe("action skipped because it requires LLM reasoning")
			expect(body.files).toBeUndefined()
		})
	})

	describe("preview list matches manifest action list (VAL-SCAN-012)", () => {
		it("every manifest action has exactly one preview record — no extras, none missing", async () => {
			// Three actions: two non-reasoning writers + one
			// requiresReasoning. The manifest declares all three;
			// the /previews endpoint must surface exactly one record
			// per action, with state "rendered" for the writers and
			// "needs-llm" for the reasoning action.
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
				modulePath: "multi",
				actions: [
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
					modulePath: "multi",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			const listRes = await stack.fx.app.request("/v1/modules/acme/multi/v1.0.0/previews")
			const listBody = (await listRes.json()) as {
				previews: Array<{ actionId: string; state: string }>
			}

			// Set equality: the served actionIds must equal the
			// manifest's action ids; each served state matches the
			// action's `requiresReasoning` declaration (the two
			// writers are `rendered`, `reason` is `needs-llm`).
			const servedActionIds = new Set(listBody.previews.map((p) => p.actionId).sort())
			expect([...servedActionIds]).toEqual(["reason", "writer-a", "writer-b"])
			expect(findPreview(listBody.previews, "writer-a")?.state).toBe("rendered")
			expect(findPreview(listBody.previews, "writer-b")?.state).toBe("rendered")
			expect(findPreview(listBody.previews, "reason")?.state).toBe("needs-llm")
		})
	})

	describe("public previews served without authentication (VAL-SCAN-019)", () => {
		it("a public module's previews are reachable with no credential", async () => {
			const actionBody = `
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
				modulePath: "pub",
				actions: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt"],
						body: actionBody,
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
					modulePath: "pub",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			// No `x-api-key`, no cookie — public preview is unauth.
			const listRes = await stack.fx.app.request("/v1/modules/acme/pub/v1.0.0/previews")
			expect(listRes.status).toBe(200)
			const listBody = (await listRes.json()) as { previews: Array<{ actionId: string }> }
			expect(listBody.previews.length).toBe(1)
			expect(listBody.previews[0]?.actionId).toBe("writer")

			// Per-action detail is also unauth for public modules.
			const detailRes = await stack.fx.app.request("/v1/modules/acme/pub/v1.0.0/previews/writer")
			expect(detailRes.status).toBe(200)
			const detailBody = (await detailRes.json()) as {
				state: string
				files?: Array<{ path: string; content: string }>
			}
			expect(detailBody.state).toBe("rendered")
			expect(detailBody.files?.[0]?.content).toBe("public-content")
		})

		it("org-visibility previews are filtered by the same uniform 404 envelope as a missing module", async () => {
			// Same fixture, but published with visibility: "org".
			// Org-visibility modules skip screening entirely
			// (decision 30: "private by default"), so no preview
			// record exists. The visibility gate returns the
			// uniform "version not found" envelope for non-members
			// (VAL-AUTH-019: existence not leaked); proven members
			// see the "no preview record" envelope because the
			// screening pipeline intentionally skips org-visibility.
			// Both surfaces return 404 with HONEST but DIFFERENT
			// bodies — outsiders cannot tell "not a member" from
			// "no preview was generated" by reading the response.
			const actionBody = `
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
				modulePath: "priv",
				actions: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt"],
						body: actionBody,
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
					modulePath: "priv",
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

			// DB sanity: the module row exists under scope=acme,
			// name=priv so the visibility gate's SELECT has
			// something to find.
			const dbModule = await stack.fx.pglite.query<{ scope: string; name: string; visibility: string }>(
				`SELECT scope, name, visibility FROM modules WHERE scope = 'acme' AND name = 'priv'`,
			)
			expect(dbModule.rows.length).toBe(1)
			expect(dbModule.rows[0]?.visibility).toBe("org")

			// No credential — uniform 404 (the same envelope as a
			// missing module — visibility gate).
			const listRes = await stack.fx.app.request("/v1/modules/acme/priv/v1.0.0/previews")
			expect(listRes.status).toBe(404)
			const detailRes = await stack.fx.app.request("/v1/modules/acme/priv/v1.0.0/previews/writer")
			expect(detailRes.status).toBe(404)

			// Outsider (authenticated but NOT a member of acme) — same
			// uniform 404 (existence not leaked).
			const outsiderListRes = await stack.fx.app.request("/v1/modules/acme/priv/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.outsider },
			})
			expect(outsiderListRes.status).toBe(404)
			const outsiderDetailRes = await stack.fx.app.request("/v1/modules/acme/priv/v1.0.0/previews/writer", {
				headers: { "x-api-key": stack.fx.keys.outsider },
			})
			expect(outsiderDetailRes.status).toBe(404)

			// Member of acme — passes the visibility gate, so the
			// list endpoint returns 200 with an empty `previews`
			// array (screening skipped org-visibility, no records
			// were generated). The detail endpoint returns 404 with
			// the "no preview record" body — a different envelope
			// than the visibility-gate 404 above, so a member can
			// tell "this org-visibility module never produced a
			// preview" from "I'm not a member".
			const memberListRes = await stack.fx.app.request("/v1/modules/acme/priv/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.member },
			})
			expect(memberListRes.status).toBe(200)
			const memberListBody = (await memberListRes.json()) as { previews: unknown[] }
			expect(memberListBody.previews).toEqual([])
			const memberDetailRes = await stack.fx.app.request("/v1/modules/acme/priv/v1.0.0/previews/writer", {
				headers: { "x-api-key": stack.fx.keys.member },
			})
			expect(memberDetailRes.status).toBe(404)
			const memberDetailBody = (await memberDetailRes.json()) as { error?: string }
			expect(memberDetailBody.error).toContain("no preview record")
		})
	})

	describe("unknown action returns 404", () => {
		it("the per-action endpoint returns 404 for an action the module does not declare", async () => {
			const actionBody = `
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
				modulePath: "one",
				actions: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["preview.txt"],
						body: actionBody,
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
					modulePath: "one",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			await stack.fx.waitForTerminal(versionId)

			const unknownRes = await stack.fx.app.request("/v1/modules/acme/one/v1.0.0/previews/does-not-exist")
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

	it("two tags of the same module tree yield byte-identical preview content + identical content_hash", async () => {
		// Publish v1.0.0 then v1.0.1 from the SAME module tree.
		// The two commits differ (the fixture bumps a tag-only
		// ref), but the action tree is byte-equal. The dry-run
		// output is therefore byte-equal: every preview file has
		// the same sha256 in `screening_previews.files[]`, and the
		// storage adapter's content-addressed dedup means the
		// bytes served are the SAME bytes (single blob on disk).
		const actionBody = `
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
			modulePath: "det",
			actions: [
				{
					id: "writer",
					description: "writer",
					filePatterns: ["preview.txt", "nested"],
					body: actionBody,
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
				modulePath: "det",
			}),
		})
		const { versionId: versionId1 } = (await publish1.json()) as { versionId: string }
		const terminal1 = await stack.fx.waitForTerminal(versionId1)
		expect(terminal1.status).toBe("ready")

		// Second tag — v1.0.1 from the same module tree. The
		// fixture's `commitManifest` writes the SAME module tree
		// (different commit sha but identical action.ts bytes);
		// the publish endpoint only allows a manifest `version`
		// matching the tag, so we bump the version string here to
		// match the new tag.
		await stack.git.commitManifest({
			name: "@acme/det",
			version: "1.0.1",
			tag: "v1.0.1",
			modulePath: "det",
			actions: [
				{
					id: "writer",
					description: "writer",
					filePatterns: ["preview.txt", "nested"],
					body: actionBody,
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
				modulePath: "det",
			}),
		})
		const { versionId: versionId2 } = (await publish2.json()) as { versionId: string }
		const terminal2 = await stack.fx.waitForTerminal(versionId2)
		expect(terminal2.status).toBe("ready")

		// Content hashes are EQUAL across versions (same module
		// tree → same packed tarball → same content hash).
		expect(terminal1.contentHash).toBe(terminal2.contentHash)
		expect(terminal1.contentHash).not.toBe("")

		// Version 1: list endpoint carries the sha256s of every
		// rendered file. Record them for cross-version equality.
		const list1Res = await stack.fx.app.request("/v1/modules/acme/det/v1.0.0/previews", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const list1 = (await list1Res.json()) as {
			previews: Array<{
				actionId: string
				state: string
				files?: Array<{ path: string; sha256: string }>
			}>
		}
		const detail1Res = await stack.fx.app.request("/v1/modules/acme/det/v1.0.0/previews/writer", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const detail1 = (await detail1Res.json()) as {
			files?: Array<{ path: string; content: string; sha256: string }>
		}

		// Version 2: identical preview records.
		const list2Res = await stack.fx.app.request("/v1/modules/acme/det/v1.0.1/previews", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const list2 = (await list2Res.json()) as {
			previews: Array<{
				actionId: string
				state: string
				files?: Array<{ path: string; sha256: string }>
			}>
		}
		const detail2Res = await stack.fx.app.request("/v1/modules/acme/det/v1.0.1/previews/writer", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const detail2 = (await detail2Res.json()) as {
			files?: Array<{ path: string; content: string; sha256: string }>
		}

		// Set comparison: same action ids, same per-file sha256s,
		// same state — modulo the natural ordering of jsonb
		// columns (the rows are sorted by path in the response).
		expect(list1.previews.length).toBe(list2.previews.length)
		expect(list1.previews[0]?.actionId).toBe(list2.previews[0]?.actionId)
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
