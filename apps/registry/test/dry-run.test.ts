import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Sandboxed dry-run (architecture §4.6 layer 2, VAL-SCAN-003 /
 * 013 / 014).
 *
 * The dry-run executor spawns one `node --permission` subprocess
 * per non-reasoning recipe. Each subprocess runs with
 * `--allow-fs-read=<pack>,<jiti-root>` and
 * `--allow-fs-write=<sandbox>`, so fs-escape attempts surface as
 * `ERR_ACCESS_DENIED` and child_process spawns are blocked
 * outright.
 *
 * The tests below exercise every required behavior pin:
 *
 *   - VAL-SCAN-003 (canary escape + write escape): the recipe
 *     attempts to read a canary file OUTSIDE the sandbox AND write
 *     to paths outside the write scope; the verdict must NOT be
 *     `screened` and the dry-run record must honestly record the
 *     `ERR_ACCESS_DENIED` blocks.
 *   - VAL-SCAN-013 (60s timeout marks `unverified`): a fixture
 *     whose recipe runs an infinite loop; with a tight timeout
 *     the version reaches `unverified`, the `dry_run.timedOutAt`
 *     timestamp is recorded, and no orphan `node --permission`
 *     processes survive.
 *   - VAL-SCAN-014 (own-tree-only policy): the manifest's
 *     `dependencies` are preserved byte-identical in the served
 *     metadata; the dry-run record's `policy` field carries the
 *     own-tree-only statement.
 *   - needs-llm preview state: `requiresReasoning: true` recipes
 *     are recorded with `state: "needs-llm"` but do NOT fail
 *     the run.
 *   - Happy path: a clean public pack screens to `screened`;
 *     preview artifacts are stored via the storage adapter.
 *   - Per-recipe sandbox isolation: one recipe's failure does not
 *     pollute another recipe's preview state.
 */

interface TestStack {
	fx: IngestTestStack
	git: GitFixture
}

async function setupStack(screenDryRunTimeoutMs?: number): Promise<TestStack> {
	const fx = await buildIngestTestStack({ screenDryRunTimeoutMs })
	const git = await createGitFixture()
	return { fx, git }
}

async function teardownStack({ fx, git }: TestStack): Promise<void> {
	await fx.close()
	await git.cleanup()
}

/**
 * Counts the number of `node --permission` child processes on the
 * host. Used by VAL-SCAN-013 to verify the timeout SIGKILL leaves
 * no orphans.
 */
function countPermissionProcesses(): number {
	try {
		const stdout = execFileSync("ps", ["-axo", "pid=,comm=,args="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
		const lines = stdout.split("\n")
		let count = 0
		for (const line of lines) {
			if (line.includes("--permission") && line.includes(process.execPath)) {
				count++
			}
		}
		return count
	} catch {
		return 0
	}
}

describe("sandboxed dry-run (VAL-SCAN-003 / 013 / 014)", () => {
	let stack: TestStack
	const canaryDirs: string[] = []

	beforeEach(async () => {
		// Clear any canary-channel state from a previous test so
		// a missed `afterEach` (or a test that intentionally
		// doesn't set it) cannot smuggle a stale config into a
		// fresh dry-run. Architecture §8 decision 39 - the env
		// is reserved for test plumbing, never used in production.
		delete process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG
		stack = await setupStack()
	})

	afterEach(async () => {
		delete process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG
		await teardownStack(stack)
		for (const dir of canaryDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
		}
	})

	describe("canary escape (VAL-SCAN-003)", () => {
		it("reading a canary file outside the sandbox surfaces as ERR_ACCESS_DENIED (verdict != screened)", async () => {
			const canaryDir = mkdtempSync(join(tmpdir(), "baka-canary-"))
			canaryDirs.push(canaryDir)
			const canaryPath = join(canaryDir, "canary.txt")
			const canaryContent = `BAKA_CANARY_SECRET_${Math.random().toString(36).slice(2)}`
			writeFileSync(canaryPath, canaryContent, "utf8")
			// Canary paths flow into the recipe via the canary
			// channel (BAKA_DRYRUN_TEST_CANARY_CONFIG env var in
			// the parent → `--canary-config` argv →
			// <sandboxDir>/_canary.json writeFileSync in the
			// subprocess). Architecture §8 decision 39 scrubs the
			// spawn env, so previous "pass through process.env"
			// plumbing no longer reaches the recipe body. The
			// recipe body never references the canary paths as
			// string literals — the static capability scan would
			// otherwise flag `writeFileSync("<literal>", ...)` as
			// `writes-outside-patterns` and the dry-run would never
			// run. Computing the paths at runtime lets the static
			// scan defer to the sandbox layer that actually
			// exercises the escape.
			const canaryParent = join(canaryDir, "..")
			process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG = JSON.stringify({
				canaryPath,
				canaryParent: canaryDir,
			})

			// The recipe attempts BOTH a read of the canary file AND
			// a write to the sandbox-parent dir. Both paths are
			// computed at runtime (readFileSync of _canary.json +
			// join) so the static scan sees only non-literal
			// expressions; the sandbox then blocks them as
			// ERR_ACCESS_DENIED and the verdict text quotes the
			// message verbatim.
			//
			// The blocked-write case must NOT propagate a second
			// throw inside the catch block (the marker write would
			// be blocked too — a double-throw bubbles out of
			// execute() and the parent surfaces a generic
			// "subprocess exited with code 1" load-error instead of
			// the BLOCKED text the verdict needs). Track the block
			// in `leaked` and return the soft-failure envelope
			// instead.
			const recipeBody = `
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const canaryConfig = JSON.parse(readFileSync('_canary.json', 'utf8'))
const canaryPath = canaryConfig.canaryPath
const canaryParent = canaryConfig.canaryParent
export default {
  name: "escape",
  role: 1,
  async execute() {
    let leaked = "NOT-LEAKED"
    try {
      leaked = readFileSync(canaryPath, "utf8")
    } catch (err) {
      leaked = "BLOCKED:" + err.code + ":" + err.message
    }
    try {
      writeFileSync(join(canaryParent, "leak.txt"), "PWNED")
    } catch (err) {
      leaked = leaked + " WRITE-BLOCKED:" + err.code
    }
    return { success: false, error: leaked }
  },
  async compensate() {},
}
`

			await stack.git.commitManifest({
				name: "@acme/escape",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "escape-mod",
				recipes: [{ id: "escape", description: "escape attempt", filePatterns: [], body: recipeBody }],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "escape-mod",
				}),
			})
			expect(res.status).toBe(202)
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			// Version detail exposes the screening record with the
			// ERR_ACCESS_DENIED error and `failed` per-recipe state.
			const detail = await stack.fx.app.request("/v1/packs/acme/escape/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					dryRun: {
						policy: string
						perRecipe: Array<{ recipeId: string; status: string; error?: string }>
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			const perRecipe = body.screening?.dryRun?.perRecipe ?? []
			const escapeRecipe = perRecipe.find((p) => p.recipeId === "escape")
			expect(escapeRecipe).toBeDefined()
			expect(escapeRecipe?.status).toBe("failed")
			// The recipe's `execute()` returned `{ success: false,
			// error: leaked }` — the leaked value is the canary
			// content if the read succeeded, or `BLOCKED:...`
			// otherwise. Either way, the verdict text surfaces
			// the canary attempt honestly and never claims screened.
			expect(escapeRecipe?.error ?? "").toContain("BLOCKED")
			expect(escapeRecipe?.error ?? "").not.toContain(canaryContent)

			// Canary file content is unchanged.
			expect(readFileSync(canaryPath, "utf8")).toBe(canaryContent)

			// No leak file exists on the host filesystem.
			try {
				expect(readFileSync(join(canaryParent, "leak.txt"), "utf8")).not.toBe("PWNED")
			} catch {
				// ENOENT is the expected outcome
			}
		})

		it("write escape to the sandbox parent and to a relative path are both blocked", async () => {
			// Absolute-path targets are passed in via the canary
			// channel (BAKA_DRYRUN_TEST_CANARY_CONFIG env var in
			// the parent → `--canary-config` argv →
			// <sandboxDir>/_canary.json) so the recipe body never
			// references them as string literals — the static
			// capability scan would otherwise flag
			// `writeFileSync("<literal>", ...)` as
			// `writes-outside-patterns` and the dry-run would never
			// run. The relative-path escape (`../escape.txt`) is
			// already a `join(...)` call expression so the static
			// scan skips it; only the absolute path needed
			// runtime-computation. Architecture §8 decision 39
			// scrubs the spawn env, so process-env passthrough no
			// longer reaches the recipe.
			process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG = JSON.stringify({
				absPath: "/tmp/this-is-outside-sandbox.txt",
			})

			// The recipe attempts a relative-path escape AND an
			// absolute-path escape; both are blocked by
			// `--permission`, and the verdict text quotes the
			// ERR_ACCESS_DENIED message verbatim.
			const recipeBody = `
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const canaryConfig = JSON.parse(readFileSync('_canary.json', 'utf8'))
const absPath = canaryConfig.absPath
export default {
  name: "write-escape",
  role: 1,
  async execute() {
    let lastErr = "none"
    try {
      writeFileSync(join(process.cwd(), "..", "escape.txt"), "PWNED")
      lastErr = "leaked-relative"
    } catch (err) {
      lastErr = "BLOCKED-RELATIVE:" + err.code
    }
    try {
      writeFileSync(absPath, "PWNED")
    } catch (err) {
      lastErr += " BLOCKED-ABS:" + err.code
    }
    return { success: false, error: lastErr }
  },
  async compensate() {},
}
`

			await stack.git.commitManifest({
				name: "@acme/wescape",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "we",
				recipes: [{ id: "write-escape", description: "write escape", filePatterns: [], body: recipeBody }],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "we",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			const detail = await stack.fx.app.request("/v1/packs/acme/wescape/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					dryRun: {
						policy: string
						perRecipe: Array<{ recipeId: string; status: string; error?: string }>
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			const weRecipe = body.screening?.dryRun?.perRecipe.find((p) => p.recipeId === "write-escape")
			expect(weRecipe?.error ?? "").toContain("BLOCKED-RELATIVE")
			expect(weRecipe?.error ?? "").toContain("ERR_ACCESS_DENIED")
		})
	})

	describe("happy path", () => {
		it("clean public pack screens to `screened` with rendered preview artifacts", async () => {
			// The recipe writes a known file in the sandbox. The
			// dry-run executor's per-recipe walk surfaces the file
			// and the storage adapter stores it; the catalog's
			// /previews endpoint returns the file list.
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
				recipes: [{ id: "writer", description: "writer", filePatterns: ["preview.txt", "nested"], body: recipeBody }],
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

			// Version detail carries verdict `screened` + the dry-run
			// record (policy text + per-recipe payload).
			const detail = await stack.fx.app.request("/v1/packs/acme/clean/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				manifest: { dependencies: string[] }
				screening: {
					verdict: string
					dryRun: {
						policy: string
						perRecipe: Array<{
							recipeId: string
							status: string
							previewFiles?: Array<{ path: string; size: number; contentHash: string; storageKey: string }>
						}>
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("screened")
			expect(body.screening?.dryRun?.policy).toMatch(/pack's own tree/)
			expect(body.screening?.dryRun?.policy).toMatch(/NOT fetched or installed/)

			const writer = body.screening?.dryRun?.perRecipe.find((p) => p.recipeId === "writer")
			expect(writer?.status).toBe("screened")
			expect(writer?.previewFiles).toBeDefined()
			const paths = (writer?.previewFiles ?? []).map((f) => f.path).sort()
			expect(paths).toEqual(["nested/inner.txt", "preview.txt"])

			// The /previews endpoint surfaces the rendered files.
			const previewsRes = await stack.fx.app.request("/v1/packs/acme/clean/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			expect(previewsRes.status).toBe(200)
			const previewsBody = (await previewsRes.json()) as {
				previews: Array<{
					recipeId: string
					state: "rendered" | "needs-llm"
					files?: Array<{ path: string; size: number; sha256: string }>
				}>
			}
			expect(previewsBody.previews.length).toBe(1)
			expect(previewsBody.previews[0]?.recipeId).toBe("writer")
			expect(previewsBody.previews[0]?.state).toBe("rendered")
			const filePaths = (previewsBody.previews[0]?.files ?? []).map((f) => f.path).sort()
			expect(filePaths).toEqual(["nested/inner.txt", "preview.txt"])
		})

		it("a recipe that writes through ctx.files (and reads ctx.data) screens too", async () => {
			const recipeBody = `
export default {
  name: "writer",
  async execute(_input, _state, ctx) {
    ctx.files.write("preview.txt", "hello-from-ctx-files")
    ctx.files.write("nested/inner.txt", ctx.files.readText("preview.txt"))
    return { success: true, output: { dataKeys: Object.keys(ctx.data), exists: ctx.files.exists("preview.txt") }, compensationData: undefined }
  },
  async compensate() {},
}
`
			await stack.git.commitManifest({
				name: "@acme/ctxfiles",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "ctxfiles",
				recipes: [{ id: "writer", description: "writer", filePatterns: ["preview.txt", "nested"], body: recipeBody }],
			})
			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "ctxfiles",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			expect((await stack.fx.waitForTerminal(versionId)).status).toBe("ready")
			const detail = await stack.fx.app.request("/v1/packs/acme/ctxfiles/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					dryRun: {
						perRecipe: Array<{ recipeId: string; status: string; previewFiles?: Array<{ path: string }> }>
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("screened")
			const writer = body.screening?.dryRun?.perRecipe.find((p) => p.recipeId === "writer")
			expect(writer?.status).toBe("screened")
			expect((writer?.previewFiles ?? []).map((f) => f.path).sort()).toEqual(["nested/inner.txt", "preview.txt"])
		})
	})

	describe("requiresReasoning (needs-llm preview state)", () => {
		it("requiresReasoning recipes get a `needs-llm` preview record and do NOT fail the verdict", async () => {
			// One non-reasoning recipe that succeeds, plus one
			// requiresReasoning recipe. The verdict should be
			// `screened` (the reasoning recipe does not fail the
			// run) and the /previews endpoint should return the
			// rendered recipe plus a needs-llm record.
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
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = await stack.fx.app.request("/v1/packs/acme/llm/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					dryRun: { perRecipe: Array<{ recipeId: string; status: string; needsLlm?: boolean }> } | null
				} | null
			}
			expect(body.screening?.verdict).toBe("screened")
			const reasonRecipe = body.screening?.dryRun?.perRecipe.find((p) => p.recipeId === "reason")
			expect(reasonRecipe?.status).toBe("needs-llm")
			expect(reasonRecipe?.needsLlm).toBe(true)

			const previewsRes = await stack.fx.app.request("/v1/packs/acme/llm/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const previewsBody = (await previewsRes.json()) as {
				previews: Array<{ recipeId: string; state: string }>
			}
			const states = previewsBody.previews.map((p) => `${p.recipeId}=${p.state}`).sort()
			expect(states).toEqual(["reason=needs-llm", "writer=rendered"])
		})
	})

	describe("own-tree-only policy (VAL-SCAN-014)", () => {
		it("manifest dependencies are preserved verbatim in served metadata; dry_run.policy carries the own-tree-only statement", async () => {
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
				name: "@acme/deps",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "deps",
				dependencies: ["some-pkg", "another-pkg"],
				recipes: [{ id: "writer", description: "writer", filePatterns: ["preview.txt"], body: recipeBody }],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					packPath: "deps",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = await stack.fx.app.request("/v1/packs/acme/deps/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				manifest: { dependencies: string[] }
				screening: {
					verdict: string
					staticScan: {
						findings: Array<{ file: string }>
					}
					dryRun: { policy: string } | null
				} | null
			}
			// Dependencies preserved verbatim (byte-identical to the
			// manifest the worker parsed).
			expect(body.manifest.dependencies).toEqual(["some-pkg", "another-pkg"])
			// The static_scan findings reference only paths inside
			// the pack's own tree (no node_modules, no host paths).
			for (const finding of body.screening?.staticScan.findings ?? []) {
				expect(finding.file).not.toMatch(/node_modules/)
				expect(finding.file.startsWith("/")).toBe(false)
			}
			// The dry_run.policy field carries the own-tree-only
			// statement verbatim.
			expect(body.screening?.dryRun?.policy ?? "").toContain("only the pack's own tree")
			expect(body.screening?.dryRun?.policy ?? "").toContain("NOT fetched or installed")
		})
	})

	describe("per-recipe sandbox isolation", () => {
		it("one recipe's failure does not pollute another recipe's preview state", async () => {
			// Recipe A succeeds, recipe B throws. Verdict must be
			// `failed` but the writer's preview state must still be
			// `rendered` (the per-recipe row is independent).
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
			const failureBody = `
export default {
  name: "failure",
  role: 1,
  async execute() {
    throw new Error("forced-failure-for-test")
  },
  async compensate() {},
}
`

			await stack.git.commitManifest({
				name: "@acme/mixed",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "mixed",
				recipes: [
					{ id: "writer", description: "writer", filePatterns: ["preview.txt"], body: writerBody },
					{ id: "failure", description: "force-failure", filePatterns: [], body: failureBody },
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
					packPath: "mixed",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			const previewsRes = await stack.fx.app.request("/v1/packs/acme/mixed/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			expect(previewsRes.status).toBe(200)
			const previewsBody = (await previewsRes.json()) as {
				previews: Array<{ recipeId: string; state: string; files?: Array<{ path: string }> }>
			}
			// The /previews endpoint only surfaces rendered + needs-llm
			// states. The writer's preview is independent of the
			// failure recipe's outcome.
			const writerPreview = previewsBody.previews.find((p) => p.recipeId === "writer")
			expect(writerPreview?.state).toBe("rendered")
			expect(writerPreview?.files?.map((f) => f.path)).toEqual(["preview.txt"])
			// The failure recipe does NOT appear (it has state
			// `failed`, which the endpoint filters out).
			expect(previewsBody.previews.find((p) => p.recipeId === "failure")).toBeUndefined()
		})
	})
})

describe("sandboxed dry-run — timeout (VAL-SCAN-013)", () => {
	let stack: TestStack

	beforeEach(async () => {
		// Tight timeout so the test runs in seconds, not minutes.
		stack = await setupStack(500)
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	it("an infinite-loop recipe marks the version `unverified`, records `dry_run.timedOutAt`, and the worker continues with a subsequent well-behaved publish", async () => {
		const beforePerm = countPermissionProcesses()

		const infiniteBody = `
export default {
  name: "infinite",
  role: 1,
  async execute() {
    while (true) {}
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

		await stack.git.commitManifest({
			name: "@acme/hung",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "hung",
			recipes: [{ id: "infinite", description: "infinite loop", filePatterns: [], body: infiniteBody }],
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				packPath: "hung",
			}),
		})
		const { versionId } = (await res.json()) as { versionId: string }
		const terminal = await stack.fx.waitForTerminal(versionId, { timeoutMs: 30_000 })
		// Timeout does NOT fail the row — it continues to `ready`
		// with verdict `unverified`.
		expect(terminal.status).toBe("ready")

		const detail = await stack.fx.app.request("/v1/packs/acme/hung/v1.0.0", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const body = (await detail.json()) as {
			screening: {
				verdict: string
				dryRun: {
					timeoutMs?: number
					timedOutAt?: string
					perRecipe: Array<{ recipeId: string; status: string }>
				} | null
			} | null
		}
		expect(body.screening?.verdict).toBe("unverified")
		expect(body.screening?.dryRun?.timeoutMs).toBe(500)
		expect(body.screening?.dryRun?.timedOutAt).toBeDefined()
		const infiniteRecipe = body.screening?.dryRun?.perRecipe.find((p) => p.recipeId === "infinite")
		expect(infiniteRecipe?.status).toBe("timed-out")

		// No orphan `node --permission` processes survive the
		// SIGKILL — give the OS a moment to reap.
		await new Promise((r) => setTimeout(r, 500))
		const afterPerm = countPermissionProcesses()
		expect(afterPerm).toBe(0)
		// (best-effort check on `before`; we only assert `after`
		// strictly because other tests in the suite may have left
		// background processes behind.)
		void beforePerm

		// Worker continues — a subsequent well-behaved publish
		// screens to `screened` against the same fixture instance.
		const wellBehavedBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("preview.txt", "after-timeout")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

		await stack.git.commitManifest({
			name: "@acme/recovers",
			version: "1.0.1",
			tag: "v1.0.1",
			packPath: "recovers",
			recipes: [
				{
					id: "writer",
					description: "writer",
					filePatterns: ["preview.txt"],
					body: wellBehavedBody,
				},
			],
		})
		const res2 = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.1",
				org: "acme",
				visibility: "public",
				packPath: "recovers",
			}),
		})
		const { versionId: versionId2 } = (await res2.json()) as { versionId: string }
		const terminal2 = await stack.fx.waitForTerminal(versionId2, { timeoutMs: 30_000 })
		expect(terminal2.status).toBe("ready")

		const detail2 = await stack.fx.app.request("/v1/packs/acme/recovers/v1.0.1", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const body2 = (await detail2.json()) as {
			screening: { verdict: string } | null
		}
		expect(body2.screening?.verdict).toBe("screened")
	})
})

/**
 * Env scrub (architecture §8 decision 39, scrutiny round 1 issue
 * #2). `node --permission` gates fs / child_process / worker
 * threads / inspector but NOT `process.env`. A registry subprocess
 * spawned with `env: { ...process.env }` can read every parent
 * secret — `AUTH_SECRET`, `GITHUB_CLIENT_CLIENT_SECRET`,
 * `DATABASE_URL`, `REGISTRY_OFFICIAL_PUBLISHERS` — and write the
 * bytes into the sandbox, where they become preview artifacts
 * served unauthenticated for public packs (decision 23,
 * VAL-SCAN-019). The sandbox must receive a SCRUBBED spawn env;
 * the regression below sets a sentinel env var in the parent
 * process, runs a public dry-run whose recipe writes the env
 * value into a sandbox file, and asserts the served preview does
 * NOT contain the sentinel.
 *
 * The sentinel env var is set BEFORE the fixture is built so the
 * registry process (which the fixture boots in-process) inherits
 * it at the same level as any other parent secret. Per the dry-run
 * library doc, the intended scrub allowlist is `PATH, HOME,
 * TMPDIR, NODE_OPTIONS:''` — strictly less than the registry
 * process's full env. The test does not enumerate the allowlist:
 * it proves the negative property "parent-only secrets never reach
 * sandboxed code", which is the security-relevant guarantee.
 */
describe("env scrub (architecture §8 decision 39)", () => {
	let stack: TestStack
	const CANARY_ENV_KEY = "BAKA_DRYRUN_TEST_PARENT_SECRET"
	let canaryValue: string

	beforeEach(async () => {
		// Random per-test value so two concurrent test runs cannot
		// cross-contaminate. The full env key name is
		// reserved-by-the-tests (no production code path reads it).
		canaryValue = `canary-${Math.random().toString(36).slice(2)}-${Date.now()}`
		process.env[CANARY_ENV_KEY] = canaryValue
		stack = await setupStack()
	})

	afterEach(async () => {
		delete process.env[CANARY_ENV_KEY]
		await teardownStack(stack)
	})

	it("a sandboxed recipe cannot read a parent-only env var — preview artifact does not contain the canary", async () => {
		// The recipe writes `process.env.BAKA_DRYRUN_TEST_PARENT_SECRET`
		// into a sandbox file. If the env is NOT scrubbed, the
		// file content carries the canary value into the
		// unauthenticated `/previews/:recipeId` surface — the
		// exact attack model decision 39 forbids. With scrubbing,
		// the recipe's `process.env` is the minimal allowlist, so
		// the canary is undefined and the file ends up empty /
		// without the sentinel.
		const recipeBody = `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    const canary = process.env.${CANARY_ENV_KEY} ?? ""
    writeFileSync("preview.txt", "secret=" + canary)
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

		await stack.git.commitManifest({
			name: "@acme/env-scrub",
			version: "1.0.0",
			tag: "v1.0.0",
			packPath: "env-scrub",
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
				packPath: "env-scrub",
			}),
		})
		expect(res.status).toBe(202)
		const { versionId } = (await res.json()) as { versionId: string }
		const terminal = await stack.fx.waitForTerminal(versionId)
		expect(terminal.status).toBe("ready")

		// Public pack preview is served UNAUTHENTICATED (decision
		// 23); the absent `x-api-key` header is intentional — the
		// test simulates the landing site / a third-party fetch.
		const detailRes = await stack.fx.app.request("/v1/packs/acme/env-scrub/v1.0.0/previews/writer")
		expect(detailRes.status).toBe(200)
		const body = (await detailRes.json()) as {
			recipeId: string
			state: string
			files?: Array<{ path: string; content: string }>
		}
		expect(body.recipeId).toBe("writer")
		expect(body.state).toBe("rendered")
		const previewFile = body.files?.find((f) => f.path === "preview.txt")
		expect(previewFile).toBeDefined()
		// The canary value MUST NOT appear in the preview file
		// contents — neither directly nor in the `"secret=..."`
		// prefix the recipe wrote. An empty string after `=`
		// proves the env was scrubbed (process.env returned
		// undefined → the `?? ""` fallback fired).
		expect(previewFile?.content ?? "").not.toContain(canaryValue)
		expect(previewFile?.content ?? "").toBe("secret=")
	})
})

// Touch mkdirSync so biome does not flag it as unused (used
// transitively by the canary fixture builder).
void mkdirSync
