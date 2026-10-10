import { createHash } from "node:crypto"
import Handlebars from "handlebars"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * `{{!-- no-llm --}}` sentinel preview render + tier parity on the
 * version-detail read surface (architecture §4.6 layer 2 + decision
 * 31 + VAL-SCAN-005 conditional clause + VAL-SCAN-008 tier parity
 * completeness push).
 *
 * Sentinel semantics mirror the engine's `NO_LLM_SENTINEL` definition
 * (`packages/ast-tooling/src/worker.ts:24`,
 *  `/\{\{!--\s*no-llm\s*--\}\}/`). When a `.hbs` file under
 * `<packRoot>/<recipeId>/templates/` carries the sentinel, the
 * registry's dry-run renders it with Handlebars inside the same
 * `node --permission` sandbox used for non-reasoning recipes and
 * records the rendered bytes as the recipe's preview files. The
 * state stays `needs-llm` because the recipe still requires LLM
 * reasoning at apply time — the sentinel path only previews what a
 * non-LLM render produces. Reasoning recipes whose templates do
 * NOT carry the sentinel (or that ship no templates) keep the
 * pre-existing `needs-llm` shape: `state` + `reason`, no `files`.
 *
 * VAL-SCAN-008 requires the tier field to appear IDENTICALLY on all
 * three read surfaces (catalog list, pack detail, version detail).
 * The first two have always served the tier; the version-detail
 * endpoint served only the verdict via the `screening` field. The
 * fix adds a `tier` field on the version-detail payload so the
 * parity holds.
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

/** sha256 hex digest of a string (used to compare preview content). */
function sha256Hex(content: string): string {
	return createHash("sha256").update(content).digest("hex")
}

/** Locates one preview record by recipeId. */
function findPreview<T extends { recipeId: string }>(previews: T[], recipeId: string): T | undefined {
	return previews.find((p) => p.recipeId === recipeId)
}

describe("{{!-- no-llm --}} sentinel preview render (VAL-SCAN-005)", () => {
	let stack: TestStack

	beforeEach(async () => {
		// Clear any canary-channel state from a previous test so a
		// missed afterEach cannot smuggle a stale config into a
		// fresh dry-run (architecture §8 decision 39).
		delete process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG
		stack = await setupStack()
	})

	afterEach(async () => {
		delete process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG
		await teardownStack(stack)
	})

	it("a reasoning recipe WITH a sentinel template produces state=needs-llm plus the rendered content", async () => {
		// Template body declares the sentinel at the top of the
		// file so the dry-run picks it up; the body references a
		// {{name}} Handlebars parameter we render against an empty
		// context. The rendered content (the only file the
		// recipe produces via the sentinel path) surfaces on the
		// per-recipe detail endpoint with `state: "needs-llm"`.
		const templateBody = `{{!-- no-llm --}}Hello {{name}} from a sentinel template.\n`
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
			name: "@acme/sentinel",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "sentinel",
			recipes: [
				{
					id: "reason",
					description: "reasoning recipe with sentinel template",
					filePatterns: [],
					requiresReasoning: true,
					body: reasoningBody,
				},
			],
			extras: [{ path: "reason/templates/greeting.hbs", content: templateBody }],
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				packPath: "sentinel",
			}),
		})
		expect(res.status).toBe(202)
		const { versionId } = (await res.json()) as { versionId: string }
		const terminal = await stack.fx.waitForTerminal(versionId)
		expect(terminal.status).toBe("ready")

		// List endpoint — the reasoning recipe surfaces with state
		// `needs-llm` AND a non-empty `files` array (the rendered
		// template). The files array is present iff a sentinel
		// render produced content.
		const listRes = await stack.fx.app.request("/v1/packs/acme/sentinel/v1.0.0/previews", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const listBody = (await listRes.json()) as {
			previews: Array<{
				recipeId: string
				state: string
				files?: Array<{ path: string; size: number; sha256: string }>
			}>
		}
		expect(listBody.previews.length).toBe(1)
		const listEntry = findPreview(listBody.previews, "reason")
		expect(listEntry?.state).toBe("needs-llm")
		expect(listEntry?.files).toBeDefined()
		expect(listEntry?.files?.length).toBe(1)
		// Path = templates/greeting.hbs, with `.hbs` stripped and
		// the `templates/` prefix removed (relative path under the
		// recipe's templates dir, mirroring the engine's `key`).
		expect(listEntry?.files?.[0]?.path).toBe("greeting")
		// Size is the RENDERED content size, not the template
		// size — Handlebars strips the {{!-- ... --}} sentinel
		// comment from the output (mirrors engine behavior
		// exactly).
		const expectedRendered = Handlebars.compile(templateBody)({})
		expect(listEntry?.files?.[0]?.size).toBe(Buffer.byteLength(expectedRendered, "utf8"))

		// Per-recipe detail endpoint — state=needs-llm, reason
		// verbatim, files array present with rendered bytes.
		const detailRes = await stack.fx.app.request("/v1/packs/acme/sentinel/v1.0.0/previews/reason", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		expect(detailRes.status).toBe(200)
		const detail = (await detailRes.json()) as {
			recipeId: string
			state: "needs-llm" | "rendered"
			reason?: string
			files?: Array<{ path: string; content: string; size: number; sha256: string }>
		}
		expect(detail.recipeId).toBe("reason")
		expect(detail.state).toBe("needs-llm")
		expect(detail.reason).toBe("recipe skipped because it requires LLM reasoning")
		expect(detail.files).toBeDefined()
		expect(detail.files?.length).toBe(1)
		expect(detail.files?.[0]?.path).toBe("greeting")
		// Rendered content byte-equal to a local Handlebars render
		// of the same template against an empty parameter context
		// (the dry-run's `input.parameters` is `{}`).
		const local = Handlebars.compile(templateBody)({})
		expect(detail.files?.[0]?.content).toBe(local)
		expect(detail.files?.[0]?.sha256).toBe(sha256Hex(local))
	})

	it("a reasoning recipe WITH multiple sentinel templates produces one preview file per template (mirroring engine key)", async () => {
		// Three sentinel-marked templates under nested directories
		// — the registry must surface one preview file per
		// template, with paths matching the engine's `key` (path
		// relative to the templates dir, `.hbs` stripped).
		const greeting = `{{!-- no-llm --}}Hi {{name}}!`
		const farewell = `{{!-- no-llm --}}Bye {{name}}!`
		const nested = `{{!-- no-llm --}}nested greet for {{name}}`

		await stack.git.commitManifest({
			name: "@acme/multi-sentinel",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "multi",
			recipes: [
				{
					id: "reason",
					description: "reasoning with multiple sentinel templates",
					filePatterns: [],
					requiresReasoning: true,
					body: `export default { name: "reason", role: 1, async execute() { return { success: true, output: undefined, compensationData: undefined } }, async compensate() {} }`,
				},
			],
			extras: [
				{ path: "reason/templates/greeting.hbs", content: greeting },
				{ path: "reason/templates/farewell.hbs", content: farewell },
				{ path: "reason/templates/nested/hello.hbs", content: nested },
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

		const detailRes = await stack.fx.app.request("/v1/packs/acme/multi-sentinel/v1.0.0/previews/reason", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const detail = (await detailRes.json()) as {
			state: string
			files?: Array<{ path: string; content: string }>
		}
		expect(detail.state).toBe("needs-llm")
		expect(detail.files?.length).toBe(3)
		const paths = (detail.files ?? []).map((f) => f.path).sort()
		// Engine key = templates-relative path with `.hbs` stripped.
		expect(paths).toEqual(["farewell", "greeting", "nested/hello"])
		const byPath = new Map((detail.files ?? []).map((f) => [f.path, f] as const))
		expect(byPath.get("greeting")?.content).toBe(Handlebars.compile(greeting)({}))
		expect(byPath.get("farewell")?.content).toBe(Handlebars.compile(farewell)({}))
		expect(byPath.get("nested/hello")?.content).toBe(Handlebars.compile(nested)({}))
	})

	it("a reasoning recipe WITHOUT a sentinel template keeps the needs-llm-with-no-files shape", async () => {
		// Reasoning recipe ships NO templates dir at all — the
		// dry-run must keep the pre-existing behavior: record
		// `needs-llm` with the verbatim reason and NO files
		// carrier. This guards the no-sentinel branch from
		// regression when the sentinel path lights up.
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
			name: "@acme/no-sentinel",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "nosentinel",
			recipes: [
				{
					id: "reason",
					description: "reasoning with NO templates",
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
				packPath: "nosentinel",
			}),
		})
		const { versionId } = (await res.json()) as { versionId: string }
		const terminal = await stack.fx.waitForTerminal(versionId)
		expect(terminal.status).toBe("ready")

		// List endpoint — needs-llm with NO files carrier.
		const listRes = await stack.fx.app.request("/v1/packs/acme/no-sentinel/v1.0.0/previews", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const listBody = (await listRes.json()) as {
			previews: Array<{ recipeId: string; state: string; files?: unknown[] }>
		}
		expect(listBody.previews.length).toBe(1)
		const entry = findPreview(listBody.previews, "reason")
		expect(entry?.state).toBe("needs-llm")
		expect(entry?.files).toBeUndefined()

		// Detail endpoint — needs-llm with NO files carrier.
		const detailRes = await stack.fx.app.request("/v1/packs/acme/no-sentinel/v1.0.0/previews/reason", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const detail = (await detailRes.json()) as {
			recipeId: string
			state: string
			reason?: string
			files?: unknown[]
		}
		expect(detail.recipeId).toBe("reason")
		expect(detail.state).toBe("needs-llm")
		expect(detail.reason).toBe("recipe skipped because it requires LLM reasoning")
		expect(detail.files).toBeUndefined()
	})

	it("a reasoning recipe WITH a non-sentinel template does NOT render (non-sentinel templates stay LLM-only)", async () => {
		// Sentinel detection is exact: only `.hbs` files carrying
		// the `{{!-- no-llm --}}` comment are rendered. A
		// template WITHOUT the sentinel stays an LLM-only path —
		// the registry does NOT render it (only the engine-side
		// SAGA calls the LLM). The dry-run produces `needs-llm`
		// with NO files carrier.
		const nonSentinelTemplate = `Hi {{name}}!`
		await stack.git.commitManifest({
			name: "@acme/llm-only-template",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "llm-only",
			recipes: [
				{
					id: "reason",
					description: "reasoning with non-sentinel template",
					filePatterns: [],
					requiresReasoning: true,
					body: `export default { name: "reason", role: 1, async execute() { return { success: true, output: undefined, compensationData: undefined } }, async compensate() {} }`,
				},
			],
			extras: [{ path: "reason/templates/greeting.hbs", content: nonSentinelTemplate }],
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				packPath: "llm-only",
			}),
		})
		const { versionId } = (await res.json()) as { versionId: string }
		await stack.fx.waitForTerminal(versionId)

		const detailRes = await stack.fx.app.request("/v1/packs/acme/llm-only-template/v1.0.0/previews/reason", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const detail = (await detailRes.json()) as { state: string; files?: unknown[] }
		expect(detail.state).toBe("needs-llm")
		expect(detail.files).toBeUndefined()
	})

	it("the sentinel render runs inside the sandbox — env scrub prevents parent secret exfiltration", async () => {
		// Architecture §8 decision 39 scrubs the dry-run subprocess's
		// process.env to the minimal allowlist
		// {PATH, HOME, TMPDIR, NODE_OPTIONS:''} and wires test values
		// through the `<sandbox>/_canary.json` argv channel instead.
		// We set BAKA_DRYRUN_TEST_CANARY_CONFIG with a sentinel
		// value and verify the rendered template output does NOT
		// contain the canary: the Handlebars context is `{}`, so
		// any reference to a canary key in the template resolves to
		// undefined (empty render), proving the render cannot pull
		// parent-secret values from any source.
		const parentOnlySecret = `BAKA_TEST_AUTH_SECRET_${Math.random().toString(36).slice(2)}`
		process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG = JSON.stringify({ parentOnlySecret })

		const templateBody = `{{!-- no-llm --}}canary={{parentOnlySecret}}!`
		await stack.git.commitManifest({
			name: "@acme/sentinel-no-leak",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "no-leak",
			recipes: [
				{
					id: "reason",
					description: "reasoning with sentinel template that references the canary",
					filePatterns: [],
					requiresReasoning: true,
					body: `export default { name: "reason", role: 1, async execute() { return { success: true, output: undefined, compensationData: undefined } }, async compensate() {} }`,
				},
			],
			extras: [{ path: "reason/templates/greeting.hbs", content: templateBody }],
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				packPath: "no-leak",
			}),
		})
		const { versionId } = (await res.json()) as { versionId: string }
		await stack.fx.waitForTerminal(versionId)

		const detailRes = await stack.fx.app.request("/v1/packs/acme/sentinel-no-leak/v1.0.0/previews/reason", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const detail = (await detailRes.json()) as { state: string; files?: Array<{ content: string }> }
		expect(detail.state).toBe("needs-llm")
		expect(detail.files).toBeDefined()
		// The canary string MUST NOT appear anywhere in the rendered
		// output — a future bug that pulls parent secrets into the
		// Handlebars context would trip this assertion.
		const combined = (detail.files ?? []).map((f) => f.content).join("\n")
		expect(combined).not.toContain(parentOnlySecret)
	})
})

describe("version-detail tier parity (VAL-SCAN-008)", () => {
	let stack: TestStack

	beforeEach(async () => {
		delete process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG
		stack = await setupStack()
	})

	afterEach(async () => {
		delete process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG
		await teardownStack(stack)
	})

	async function fetchTiersAcrossAllThreeReadSurfaces(opts: {
		scope: string
		name: string
		version: string
	}): Promise<{ listTier: string; packTier: string; versionTier: string | undefined }> {
		const [listRes, packRes, versionRes] = await Promise.all([
			stack.fx.app.request("/v1/packs", { headers: { "x-api-key": stack.fx.keys.owner } }),
			stack.fx.app.request(`/v1/packs/${opts.scope}/${opts.name}`, {
				headers: { "x-api-key": stack.fx.keys.owner },
			}),
			stack.fx.app.request(`/v1/packs/${opts.scope}/${opts.name}/${opts.version}`, {
				headers: { "x-api-key": stack.fx.keys.owner },
			}),
		])
		const list = (await listRes.json()) as { packs: Array<{ tier: string; scope: string; name: string }> }
		const listEntry = list.packs.find((m) => m.scope === opts.scope && m.name === opts.name)
		const packBody = (await packRes.json()) as { tier: string }
		const versionBody = (await versionRes.json()) as { tier?: string }
		return {
			listTier: listEntry?.tier ?? "",
			packTier: packBody.tier,
			versionTier: versionBody.tier,
		}
	}

	it("a screened pack's tier appears identically across catalog list, pack detail, and version detail (VAL-SCAN-008)", async () => {
		// Reasoning recipe with a clean (non-dangerous) sentinel
		// template → static scan passes, dry-run ok, layer 3
		// (no screened non-reasoning recipes to validate) ok →
		// verdict `screened` → tier `community-screened`. The same
		// tier must appear on all three read surfaces.
		const templateBody = `{{!-- no-llm --}}hi {{name}}\n`
		await stack.git.commitManifest({
			name: "@acme/parity-screened",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "parity-screened",
			recipes: [
				{
					id: "reason",
					description: "screened via sentinel-only pack",
					filePatterns: [],
					requiresReasoning: true,
					body: `export default { name: "reason", role: 1, async execute() { return { success: true, output: undefined, compensationData: undefined } }, async compensate() {} }`,
				},
			],
			extras: [{ path: "reason/templates/greeting.hbs", content: templateBody }],
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				packPath: "parity-screened",
			}),
		})
		const { versionId } = (await res.json()) as { versionId: string }
		const terminal = await stack.fx.waitForTerminal(versionId)
		expect(terminal.status).toBe("ready")

		const { listTier, packTier, versionTier } = await fetchTiersAcrossAllThreeReadSurfaces({
			scope: "acme",
			name: "parity-screened",
			version: "v1.0.0",
		})
		expect(listTier).toBe("community-screened")
		expect(packTier).toBe("community-screened")
		// Version detail MUST carry a tier field with the same
		// value — VAL-SCAN-008 parity.
		expect(versionTier).toBe("community-screened")
		expect(versionTier).toBe(listTier)
		expect(versionTier).toBe(packTier)
	})

	it("an unverified pack's tier appears identically across catalog list, pack detail, and version detail (VAL-SCAN-008)", async () => {
		// A pack's recipe body uses `fetch` (network), which the
		// static capability scan (layer 1) reliably detects and
		// flags — verdict `failed`, tier `community-unverified`.
		// The same tier must appear on all three read surfaces.
		await stack.git.commitManifest({
			name: "@acme/parity-unverified",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "parity-unverified",
			recipes: [
				{
					id: "reason",
					description: "screening fails (recipe body uses fetch)",
					filePatterns: [],
					requiresReasoning: true,
					body: `export default {
  name: "reason",
  role: 1,
  async execute() {
    fetch("https://evil.example/x")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}`,
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
				packPath: "parity-unverified",
			}),
		})
		const { versionId } = (await res.json()) as { versionId: string }
		const terminal = await stack.fx.waitForTerminal(versionId)
		expect(terminal.status).toBe("failed")

		const { listTier, packTier, versionTier } = await fetchTiersAcrossAllThreeReadSurfaces({
			scope: "acme",
			name: "parity-unverified",
			version: "v1.0.0",
		})
		expect(listTier).toBe("community-unverified")
		expect(packTier).toBe("community-unverified")
		// Version detail MUST carry a tier field with the same
		// value — VAL-SCAN-008 parity, failure path.
		expect(versionTier).toBe("community-unverified")
		expect(versionTier).toBe(listTier)
		expect(versionTier).toBe(packTier)
	})
})
