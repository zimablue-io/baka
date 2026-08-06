import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Static capability scan (architecture §4.6 layer 1, VAL-SCAN-002 / 015 / 016).
 *
 * The scan runs over every `.ts` file in a public-visibility module and
 * over Handlebars templates (`.hbs` / `.handlebars`). It denies:
 *
 *   - network APIs: `fetch`, `WebSocket`, `http`/`https`/`net`/`dns`
 *     module imports (VAL-SCAN-002)
 *   - `child_process` module imports (VAL-SCAN-002)
 *   - `eval(...)` and `new Function(...)` (VAL-SCAN-002)
 *   - dynamic `import(<specifier>)` of non-allowlisted specifiers
 *     (VAL-SCAN-016) — allowlist: `baka-sdk`, `node:*` builtins
 *   - writes outside declared `filePatterns` (statically detectable
 *     string-literal arguments to `writeFile*` / `appendFile*` /
 *     `mkdir` / `mkdirSync`)
 *   - non-allowlisted Handlebars helpers (VAL-SCAN-015) — allowlist:
 *     builtins only (`if`, `each`, `with`, `unless`); `lookup` and
 *     raw-eval constructs are denied
 *
 * Screening is skipped entirely for org-visibility modules (decision 30,
 * private by default). The public module fails the version with
 * `status='failed'`, `screening.verdict='failed'`, the `static_scan`
 * field populated with named findings, and the `dry_run` field
 * populated with an explicit skip marker stating the dry-run was
 * skipped because the static scan failed.
 *
 * The scan also enforces a unit-level contract: `runStaticScan` returns
 * a typed result that the worker can record verbatim. Tests exercise
 * the helper directly for fast, deterministic feedback on the AST
 * detection rules, and exercise the worker integration end-to-end so
 * the DB + screening_results row stay in lock-step with the helper.
 */

describe("static capability scan (VAL-SCAN-002 / 015 / 016)", () => {
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

	describe("runStaticScan — unit-level AST detection", () => {
		it("flags `fetch(` as network", async () => {
			const moduleDir = await setupModule({
				"action.ts": `export default { execute: () => fetch("https://evil.example/x") }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", ["package.json"]))
			expect(result.passed).toBe(false)
			expect(findCapability(result, "network")).toBeDefined()
			expect(findCapability(result, "network")?.file).toBe("action.ts")
		})

		it("flags `WebSocket` as network", async () => {
			const moduleDir = await setupModule({
				"action.ts": `export default { execute: () => new WebSocket("ws://evil.example") }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(false)
			expect(findCapability(result, "network")).toBeDefined()
		})

		it("flags `import ... from 'http'` / 'https' / 'net' / 'dns' as network", async () => {
			const moduleDir = await setupModule({
				"action.ts": `import http from "http";\nexport default { execute: () => http.get("https://evil.example") }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(false)
			expect(findCapability(result, "network")).toBeDefined()
		})

		it("flags `child_process` module references", async () => {
			const moduleDir = await setupModule({
				"action.ts": `import cp from "child_process";\nexport default { execute: () => cp.exec("rm -rf /") }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(false)
			expect(findCapability(result, "child_process")).toBeDefined()
		})

		it("flags `eval(` as eval", async () => {
			const moduleDir = await setupModule({
				"action.ts": `export default { execute: () => eval("process.env") }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(false)
			expect(findCapability(result, "eval")).toBeDefined()
		})

		it("flags `new Function(` as eval", async () => {
			const moduleDir = await setupModule({
				"action.ts": `export default { execute: () => new Function("return process")() }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(false)
			expect(findCapability(result, "eval")).toBeDefined()
		})

		it("flags dynamic import of a non-allowlisted specifier (VAL-SCAN-016)", async () => {
			const moduleDir = await setupModule({
				"action.ts": `export default { execute: async () => (await import("evil-pkg")).doBad() }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(false)
			const finding = findCapability(result, "dynamic-import")
			expect(finding).toBeDefined()
			expect(finding?.snippet).toContain("evil-pkg")
		})

		it("allows dynamic import of `baka-sdk` and `node:` builtins (VAL-SCAN-016 positive control)", async () => {
			const moduleDir = await setupModule({
				"action.ts": [
					`export default {`,
					`  execute: async () => {`,
					`    await import("baka-sdk");`,
					`    await import("node:fs");`,
					`    await import("node:path");`,
					`  },`,
					`}`,
				].join("\n"),
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(true)
		})

		it("flags writes outside declared filePatterns (statically detectable string literals)", async () => {
			const moduleDir = await setupModule({
				"action.ts": `import { writeFileSync } from "node:fs";\nexport default { execute: () => writeFileSync("/etc/passwd", "boom") }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", ["package.json"]))
			expect(result.passed).toBe(false)
			const finding = findCapability(result, "writes-outside-patterns")
			expect(finding).toBeDefined()
			expect(finding?.snippet).toContain("/etc/passwd")
		})

		it("does NOT flag writes whose string literal path IS in declared filePatterns", async () => {
			const moduleDir = await setupModule({
				"action.ts": `import { writeFileSync } from "node:fs";\nexport default { execute: () => writeFileSync("src/index.ts", "ok") }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", ["src/index.ts"]))
			expect(result.passed).toBe(true)
		})

		it("flags non-allowlisted Handlebars helpers (VAL-SCAN-015: `lookup`)", async () => {
			const moduleDir = await setupModule({
				"templates/intro.hbs": `Hello {{lookup user "name"}}!`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(false)
			const finding = findCapability(result, "handlebars-helper")
			expect(finding).toBeDefined()
			expect(finding?.snippet).toContain("lookup")
			expect(finding?.file).toContain("intro.hbs")
		})

		it("allows Handlebars builtins (`if` / `each` / `with` / `unless`)", async () => {
			const moduleDir = await setupModule({
				"templates/intro.hbs": [
					`{{#if greeting}}`,
					`  {{#each items}}`,
					`    {{this}}`,
					`  {{/each}}`,
					`{{else}}`,
					`  {{#with fallback}}`,
					`    {{this}}`,
					`  {{/with}}`,
					`{{/if}}`,
					`{{#unless done}}pending{{/unless}}`,
				].join("\n"),
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			expect(result.passed).toBe(true)
		})

		it("passes a clean module (no findings, passed=true)", async () => {
			const moduleDir = await setupModule({
				"action.ts": [
					`import { writeFileSync } from "node:fs";`,
					`export default {`,
					`  execute: () => writeFileSync("src/index.ts", "ok"),`,
					`  compensate: () => {},`,
					`}`,
				].join("\n"),
				"_shared/utils.ts": `export const helper = () => 1`,
				"templates/intro.hbs": `Hello {{name}}!`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", ["src/index.ts"]))
			expect(result.passed).toBe(true)
			expect(result.findings).toHaveLength(0)
		})

		it("returns file paths relative to the module dir (not absolute)", async () => {
			const moduleDir = await setupModule({
				"subdir/action.ts": `export default { execute: () => fetch("https://evil.example") }`,
			})
			const result = await runScan(moduleDir, manifestWithAction("scaffold", []))
			const finding = findCapability(result, "network")
			expect(finding?.file).toBe("subdir/action.ts")
			expect(finding?.file.startsWith("/")).toBe(false)
		})
	})

	describe("worker integration — end-to-end", () => {
		it("public module with network/child_process/eval fails the version with named findings (VAL-SCAN-002)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
				extras: [
					{
						path: "scaffold/action.ts",
						content: [
							`import cp from "child_process";`,
							`import http from "http";`,
							`export default {`,
							`  execute: () => {`,
							`    fetch("https://evil.example");`,
							`    cp.exec("rm -rf /");`,
							`    eval("process.env");`,
							`  },`,
							`  compensate: () => {},`,
							`}`,
						].join("\n"),
					},
				],
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
			expect(res.status).toBe(202)
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")
			expect(terminal.error ?? "").toMatch(/static scan/i)

			// Version detail exposes the screening record: verdict=failed,
			// static_scan populated with named findings, dry_run with the
			// explicit skip marker.
			const detail = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					staticScan: {
						passed: boolean
						findings: Array<{ capability: string; file: string; snippet: string }>
					}
					dryRun: { skipped?: boolean; reason?: string } | null
				} | null
			}
			expect(body.screening).not.toBeNull()
			expect(body.screening?.verdict).toBe("failed")
			expect(body.screening?.staticScan.passed).toBe(false)
			const capabilities = new Set((body.screening?.staticScan.findings ?? []).map((f) => f.capability))
			expect(capabilities.has("network")).toBe(true)
			expect(capabilities.has("child_process")).toBe(true)
			expect(capabilities.has("eval")).toBe(true)
			expect(body.screening?.dryRun?.skipped).toBe(true)
			expect(body.screening?.dryRun?.reason ?? "").toMatch(/static.scan.failed/i)
		})

		it("public module with non-allowlisted dynamic import fails with named finding (VAL-SCAN-016)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
				extras: [
					{
						path: "scaffold/action.ts",
						content: [
							`export default {`,
							`  execute: async () => {`,
							`    await import("evil-pkg");`,
							`  },`,
							`  compensate: () => {},`,
							`}`,
						].join("\n"),
					},
				],
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
			expect(terminal.status).toBe("failed")

			const detail = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					staticScan: { findings: Array<{ capability: string; snippet: string }> }
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			const dynamicImport = (body.screening?.staticScan.findings ?? []).find((f) => f.capability === "dynamic-import")
			expect(dynamicImport).toBeDefined()
			expect(dynamicImport?.snippet).toContain("evil-pkg")
		})

		it("public module with non-allowlisted Handlebars helper fails (VAL-SCAN-015)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
				extras: [
					{
						path: "scaffold/action.ts",
						content: [`export default {`, `  execute: () => "noop",`, `  compensate: () => {},`, `}`].join("\n"),
					},
					{
						path: "scaffold/templates/intro.hbs",
						content: `Hello {{lookup user "name"}}!`,
					},
				],
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
			expect(terminal.status).toBe("failed")

			const detail = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					staticScan: { findings: Array<{ capability: string; snippet: string; file: string }> }
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			const helper = (body.screening?.staticScan.findings ?? []).find((f) => f.capability === "handlebars-helper")
			expect(helper).toBeDefined()
			expect(helper?.snippet).toContain("lookup")
			expect(helper?.file).toContain("intro.hbs")
		})

		it("clean public module passes static scan and reaches `ready` with a screening record", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
				actions: [{ id: "scaffold", description: "scaffold", filePatterns: ["src/index.ts"] }],
				extras: [
					{
						path: "scaffold/action.ts",
						content: [
							`import { writeFileSync } from "node:fs";`,
							`export default {`,
							`  execute: () => writeFileSync("src/index.ts", "ok"),`,
							`  compensate: () => {},`,
							`}`,
						].join("\n"),
					},
				],
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

			const detail = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					staticScan: { passed: boolean }
					dryRun: unknown
				} | null
			}
			// The static scan ran and passed; the overall verdict is
			// `unverified` because the dry-run layer has not landed
			// yet. Future features will update the verdict once
			// downstream layers complete.
			expect(body.screening).not.toBeNull()
			expect(body.screening?.verdict).toBe("unverified")
			expect(body.screening?.staticScan.passed).toBe(true)
			expect(body.screening?.dryRun).toBeNull()
		})

		it("org-private module skips screening entirely (no screening_results row)", async () => {
			await git.commitManifest({
				name: "@acme/widget",
				version: "1.0.0",
				tag: "v1.0.0",
				extras: [
					{
						path: "scaffold/action.ts",
						content: [
							`export default {`,
							`  execute: () => fetch("https://evil.example"),`,
							`  compensate: () => {},`,
							`}`,
						].join("\n"),
					},
				],
			})

			const res = await fx.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": fx.keys.owner },
				body: JSON.stringify({ repo: git.bareUrl, tag: "v1.0.0", org: "acme" }),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = await fx.app.request("/v1/modules/acme/widget/v1.0.0", {
				headers: { "x-api-key": fx.keys.owner },
			})
			const body = (await detail.json()) as { screening: unknown }
			expect(body.screening).toBeNull()
		})
	})
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function setupModule(files: Record<string, string>): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "baka-scan-unit-"))
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = join(dir, relPath)
		const { mkdirSync } = await import("node:fs")
		mkdirSync(join(dir, ...relPath.split("/").slice(0, -1)), { recursive: true })
		writeFileSync(fullPath, content, "utf8")
	}
	return dir
}

function manifestWithAction(id: string, filePatterns: string[]): import("@repo/protocol").ModuleManifest {
	return {
		name: "@test/widget",
		version: "1.0.0",
		description: "test",
		dependencies: [],
		conflictsWith: [],
		actions: [{ id, description: id, params: [], requiresReasoning: false, filePatterns, validators: [] }],
		moduleValidators: [],
	}
}

async function runScan(
	moduleDir: string,
	manifest: import("@repo/protocol").ModuleManifest,
): Promise<import("../src/screening/static-scan").StaticScanResult> {
	const { runStaticScan } = await import("../src/screening/static-scan")
	return runStaticScan(moduleDir, manifest)
}

function findCapability(
	result: import("../src/screening/static-scan").StaticScanResult,
	capability: string,
): import("../src/screening/static-scan").StaticScanFinding | undefined {
	return result.findings.find((f) => f.capability === capability)
}
