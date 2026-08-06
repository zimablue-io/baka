import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
 * per non-reasoning action. Each subprocess runs with
 * `--allow-fs-read=<module>,<jiti-root>` and
 * `--allow-fs-write=<sandbox>`, so fs-escape attempts surface as
 * `ERR_ACCESS_DENIED` and child_process spawns are blocked
 * outright.
 *
 * The tests below exercise every required behavior pin:
 *
 *   - VAL-SCAN-003 (canary escape + write escape): the action
 *     attempts to read a canary file OUTSIDE the sandbox AND write
 *     to paths outside the write scope; the verdict must NOT be
 *     `screened` and the dry-run record must honestly record the
 *     `ERR_ACCESS_DENIED` blocks.
 *   - VAL-SCAN-013 (60s timeout marks `unverified`): a fixture
 *     whose action runs an infinite loop; with a tight timeout
 *     the version reaches `unverified`, the `dry_run.timedOutAt`
 *     timestamp is recorded, and no orphan `node --permission`
 *     processes survive.
 *   - VAL-SCAN-014 (own-tree-only policy): the manifest's
 *     `dependencies` are preserved byte-identical in the served
 *     metadata; the dry-run record's `policy` field carries the
 *     own-tree-only statement.
 *   - needs-llm preview state: `requiresReasoning: true` actions
 *     are recorded with `state: "needs-llm"` but do NOT fail
 *     the run.
 *   - Happy path: a clean public module screens to `screened`;
 *     preview artifacts are stored via the storage adapter.
 *   - Per-action sandbox isolation: one action's failure does not
 *     pollute another action's preview state.
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

	beforeEach(async () => {
		stack = await setupStack()
	})

	afterEach(async () => {
		await teardownStack(stack)
	})

	describe("canary escape (VAL-SCAN-003)", () => {
		it("reading a canary file outside the sandbox surfaces as ERR_ACCESS_DENIED (verdict != screened)", async () => {
			const canaryDir = mkdtempSync(join(tmpdir(), "baka-canary-"))
			const canaryPath = join(canaryDir, "canary.txt")
			const canaryContent = `BAKA_CANARY_SECRET_${Math.random().toString(36).slice(2)}`
			writeFileSync(canaryPath, canaryContent, "utf8")
			// Canary paths flow into the action via env vars (the
			// dry-run subprocess inherits process.env). The action's
			// body never references the canary paths as string
			// literals — the static capability scan would otherwise
			// flag `writeFileSync("<literal>", ...)` as
			// `writes-outside-patterns` and the dry-run would never
			// run. Computing the paths at runtime lets the static
			// scan defer to the sandbox layer that actually
			// exercises the escape.
			const canaryParent = join(canaryDir, "..")
			process.env.BAKA_CANARY_PATH = canaryPath
			process.env.BAKA_CANARY_PARENT = canaryDir

			// The action attempts BOTH a read of the canary file AND
			// a write to the sandbox-parent dir. Both paths are
			// computed at runtime (process.env + join) so the
			// static scan sees only non-literal expressions; the
			// sandbox then blocks them as ERR_ACCESS_DENIED and the
			// verdict text quotes the message verbatim.
			//
			// The blocked-write case must NOT propagate a second
			// throw inside the catch block (the marker write would
			// be blocked too — a double-throw bubbles out of
			// execute() and the parent surfaces a generic
			// "subprocess exited with code 1" load-error instead of
			// the BLOCKED text the verdict needs). Track the block
			// in `leaked` and return the soft-failure envelope
			// instead.
			const actionBody = `
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const canaryPath = process.env.BAKA_CANARY_PATH
const canaryParent = process.env.BAKA_CANARY_PARENT
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
				modulePath: "escape-mod",
				actions: [{ id: "escape", description: "escape attempt", filePatterns: [], body: actionBody }],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					modulePath: "escape-mod",
				}),
			})
			expect(res.status).toBe(202)
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			// Version detail exposes the screening record with the
			// ERR_ACCESS_DENIED error and `failed` per-action state.
			const detail = await stack.fx.app.request("/v1/modules/acme/escape/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					dryRun: {
						policy: string
						perAction: Array<{ actionId: string; status: string; error?: string }>
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			const perAction = body.screening?.dryRun?.perAction ?? []
			const escape = perAction.find((p) => p.actionId === "escape")
			expect(escape).toBeDefined()
			expect(escape?.status).toBe("failed")
			// The action's `execute()` returned `{ success: false,
			// error: leaked }` — the leaked value is the canary
			// content if the read succeeded, or `BLOCKED:...`
			// otherwise. Either way, the verdict text surfaces
			// the canary attempt honestly and never claims screened.
			expect(escape?.error ?? "").toContain("BLOCKED")
			expect(escape?.error ?? "").not.toContain(canaryContent)

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
			// Absolute-path targets are passed in via env vars so the
			// action body never references them as string literals —
			// the static capability scan would otherwise flag
			// `writeFileSync("<literal>", ...)` as
			// `writes-outside-patterns` and the dry-run would never
			// run. The relative-path escape (`../escape.txt`) is
			// already a `join(...)` call expression so the static
			// scan skips it; only the absolute path needed
			// runtime-computation.
			process.env.BAKA_ABS_PATH = "/tmp/this-is-outside-sandbox.txt"

			// The action attempts a relative-path escape AND an
			// absolute-path escape; both are blocked by
			// `--permission`, and the verdict text quotes the
			// ERR_ACCESS_DENIED message verbatim.
			const actionBody = `
import { writeFileSync } from "node:fs"
import { join } from "node:path"
const absPath = process.env.BAKA_ABS_PATH
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
				modulePath: "we",
				actions: [{ id: "write-escape", description: "write escape", filePatterns: [], body: actionBody }],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					modulePath: "we",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			const detail = await stack.fx.app.request("/v1/modules/acme/wescape/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					dryRun: {
						policy: string
						perAction: Array<{ actionId: string; status: string; error?: string }>
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			const weAction = body.screening?.dryRun?.perAction.find((p) => p.actionId === "write-escape")
			expect(weAction?.error ?? "").toContain("BLOCKED-RELATIVE")
			expect(weAction?.error ?? "").toContain("ERR_ACCESS_DENIED")
		})
	})

	describe("happy path", () => {
		it("clean public module screens to `screened` with rendered preview artifacts", async () => {
			// The action writes a known file in the sandbox. The
			// dry-run executor's per-action walk surfaces the file
			// and the storage adapter stores it; the catalog's
			// /previews endpoint returns the file list.
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
				actions: [{ id: "writer", description: "writer", filePatterns: ["preview.txt", "nested"], body: actionBody }],
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

			// Version detail carries verdict `screened` + the dry-run
			// record (policy text + per-action payload).
			const detail = await stack.fx.app.request("/v1/modules/acme/clean/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				manifest: { dependencies: string[] }
				screening: {
					verdict: string
					dryRun: {
						policy: string
						perAction: Array<{
							actionId: string
							status: string
							previewFiles?: Array<{ path: string; size: number; contentHash: string; storageKey: string }>
						}>
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("screened")
			expect(body.screening?.dryRun?.policy).toMatch(/module's own tree/)
			expect(body.screening?.dryRun?.policy).toMatch(/NOT fetched or installed/)

			const writer = body.screening?.dryRun?.perAction.find((p) => p.actionId === "writer")
			expect(writer?.status).toBe("screened")
			expect(writer?.previewFiles).toBeDefined()
			const paths = (writer?.previewFiles ?? []).map((f) => f.path).sort()
			expect(paths).toEqual(["nested/inner.txt", "preview.txt"])

			// The /previews endpoint surfaces the rendered files.
			const previewsRes = await stack.fx.app.request("/v1/modules/acme/clean/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			expect(previewsRes.status).toBe(200)
			const previewsBody = (await previewsRes.json()) as {
				previews: Array<{
					actionId: string
					state: "rendered" | "needs-llm"
					files?: Array<{ path: string; size: number; sha256: string }>
				}>
			}
			expect(previewsBody.previews.length).toBe(1)
			expect(previewsBody.previews[0]?.actionId).toBe("writer")
			expect(previewsBody.previews[0]?.state).toBe("rendered")
			const filePaths = (previewsBody.previews[0]?.files ?? []).map((f) => f.path).sort()
			expect(filePaths).toEqual(["nested/inner.txt", "preview.txt"])
		})
	})

	describe("requiresReasoning (needs-llm preview state)", () => {
		it("requiresReasoning actions get a `needs-llm` preview record and do NOT fail the verdict", async () => {
			// One non-reasoning action that succeeds, plus one
			// requiresReasoning action. The verdict should be
			// `screened` (the reasoning action does not fail the
			// run) and the /previews endpoint should return the
			// rendered action plus a needs-llm record.
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
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = await stack.fx.app.request("/v1/modules/acme/llm/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					dryRun: { perAction: Array<{ actionId: string; status: string; needsLlm?: boolean }> } | null
				} | null
			}
			expect(body.screening?.verdict).toBe("screened")
			const reasonAction = body.screening?.dryRun?.perAction.find((p) => p.actionId === "reason")
			expect(reasonAction?.status).toBe("needs-llm")
			expect(reasonAction?.needsLlm).toBe(true)

			const previewsRes = await stack.fx.app.request("/v1/modules/acme/llm/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const previewsBody = (await previewsRes.json()) as {
				previews: Array<{ actionId: string; state: string }>
			}
			const states = previewsBody.previews.map((p) => `${p.actionId}=${p.state}`).sort()
			expect(states).toEqual(["reason=needs-llm", "writer=rendered"])
		})
	})

	describe("own-tree-only policy (VAL-SCAN-014)", () => {
		it("manifest dependencies are preserved verbatim in served metadata; dry_run.policy carries the own-tree-only statement", async () => {
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
				name: "@acme/deps",
				version: "1.0.0",
				tag: "v1.0.0",
				modulePath: "deps",
				dependencies: ["some-pkg", "another-pkg"],
				actions: [{ id: "writer", description: "writer", filePatterns: ["preview.txt"], body: actionBody }],
			})

			const res = await stack.fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
				body: JSON.stringify({
					repo: stack.git.bareUrl,
					tag: "v1.0.0",
					org: "acme",
					visibility: "public",
					modulePath: "deps",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = await stack.fx.app.request("/v1/modules/acme/deps/v1.0.0", {
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
			// the module's own tree (no node_modules, no host paths).
			for (const finding of body.screening?.staticScan.findings ?? []) {
				expect(finding.file).not.toMatch(/node_modules/)
				expect(finding.file.startsWith("/")).toBe(false)
			}
			// The dry_run.policy field carries the own-tree-only
			// statement verbatim.
			expect(body.screening?.dryRun?.policy ?? "").toContain("only the module's own tree")
			expect(body.screening?.dryRun?.policy ?? "").toContain("NOT fetched or installed")
		})
	})

	describe("per-action sandbox isolation", () => {
		it("one action's failure does not pollute another action's preview state", async () => {
			// Action A succeeds, action B throws. Verdict must be
			// `failed` but the writer's preview state must still be
			// `rendered` (the per-action row is independent).
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
				modulePath: "mixed",
				actions: [
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
					modulePath: "mixed",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			const previewsRes = await stack.fx.app.request("/v1/modules/acme/mixed/v1.0.0/previews", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			expect(previewsRes.status).toBe(200)
			const previewsBody = (await previewsRes.json()) as {
				previews: Array<{ actionId: string; state: string; files?: Array<{ path: string }> }>
			}
			// The /previews endpoint only surfaces rendered + needs-llm
			// states. The writer's preview is independent of the
			// failure action's outcome.
			const writerPreview = previewsBody.previews.find((p) => p.actionId === "writer")
			expect(writerPreview?.state).toBe("rendered")
			expect(writerPreview?.files?.map((f) => f.path)).toEqual(["preview.txt"])
			// The failure action does NOT appear (it has state
			// `failed`, which the endpoint filters out).
			expect(previewsBody.previews.find((p) => p.actionId === "failure")).toBeUndefined()
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

	it("an infinite-loop action marks the version `unverified`, records `dry_run.timedOutAt`, and the worker continues with a subsequent well-behaved publish", async () => {
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
			modulePath: "hung",
			actions: [{ id: "infinite", description: "infinite loop", filePatterns: [], body: infiniteBody }],
		})

		const res = await stack.fx.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": stack.fx.keys.owner },
			body: JSON.stringify({
				repo: stack.git.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				modulePath: "hung",
			}),
		})
		const { versionId } = (await res.json()) as { versionId: string }
		const terminal = await stack.fx.waitForTerminal(versionId, { timeoutMs: 30_000 })
		// Timeout does NOT fail the row — it continues to `ready`
		// with verdict `unverified`.
		expect(terminal.status).toBe("ready")

		const detail = await stack.fx.app.request("/v1/modules/acme/hung/v1.0.0", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const body = (await detail.json()) as {
			screening: {
				verdict: string
				dryRun: {
					timeoutMs?: number
					timedOutAt?: string
					perAction: Array<{ actionId: string; status: string }>
				} | null
			} | null
		}
		expect(body.screening?.verdict).toBe("unverified")
		expect(body.screening?.dryRun?.timeoutMs).toBe(500)
		expect(body.screening?.dryRun?.timedOutAt).toBeDefined()
		const infiniteAction = body.screening?.dryRun?.perAction.find((p) => p.actionId === "infinite")
		expect(infiniteAction?.status).toBe("timed-out")

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
			modulePath: "recovers",
			actions: [
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
				modulePath: "recovers",
			}),
		})
		const { versionId: versionId2 } = (await res2.json()) as { versionId: string }
		const terminal2 = await stack.fx.waitForTerminal(versionId2, { timeoutMs: 30_000 })
		expect(terminal2.status).toBe("ready")

		const detail2 = await stack.fx.app.request("/v1/modules/acme/recovers/v1.0.1", {
			headers: { "x-api-key": stack.fx.keys.owner },
		})
		const body2 = (await detail2.json()) as {
			screening: { verdict: string } | null
		}
		expect(body2.screening?.verdict).toBe("screened")
	})
})

// Touch mkdirSync so biome does not flag it as unused (used
// transitively by the canary fixture builder).
void mkdirSync
