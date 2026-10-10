import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"
import { buildIngestTestStack, type IngestTestStack } from "./ingest-worker-fixture"

/**
 * Screening output-validation (architecture §4.6 layer 3,
 * VAL-SCAN-006 / 007 / 017).
 *
 * Layer 3 runs after the dry-run (layer 2). It performs three
 * sub-layers against the dry-run output and the manifest:
 *
 *   1. Pack's own validators — load every validator the
 *      manifest declares (`packValidators` + `recipe.validators`)
 *      from the pack's own tree, run them against the union of
 *      dry-run output files materialized in a validation dir,
 *      collect diagnostics. Validator errors fail the layer.
 *
 *   2. Writes-subset-filePatterns — for every rendered preview
 *      file produced by layer 2, verify its relative path is
 *      covered by the recipe's declared `filePatterns`. This is
 *      the runtime complement to layer 1's static detection
 *      (layer 1 catches string-literal writes; layer 3 catches
 *      computed-path writes the static scanner cannot see).
 *
 *   3. Output toolchain — for recipes that declare
 *      `toolchain: 'tsc'`, run `tsc --noEmit` against the
 *      validation dir and surface the diagnostic verbatim on
 *      failure.
 *
 * Verdict routing:
 *   - All three pass → verdict `screened` (overall).
 *   - Any sub-layer fails → verdict `failed` with the layer's
 *     `step` discriminator + the failure surface (validator
 *     diagnostics, off-pattern write path, or tsc diagnostic).
 *
 * Own-tree-only policy (VAL-SCAN-014) is unchanged: validators
 * see the dry-run output dir as their `targetDirectory`, and
 * the toolchain runs against that same dir. Manifest
 * dependencies are NOT fetched or installed by the screening
 * system.
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

describe("screening output-validation (VAL-SCAN-006 / 007 / 017)", () => {
	let stack: TestStack

	beforeEach(async () => {
		// Clear the test-only canary channel so a stale config
		// from a prior test cannot smuggle into this run.
		// Architecture §8 decision 39 — the env is reserved
		// for test plumbing, never used in production.
		delete process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG
		stack = await setupStack()
	})

	afterEach(async () => {
		delete process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG
		await teardownStack(stack)
	})

	describe("pack's own validators (VAL-SCAN-006)", () => {
		it("a pack validator that rejects the dry-run output fails the version with surfaced diagnostics", async () => {
			// A pack-level validator that scans the dry-run
			// output dir and flags `src/index.ts` when its
			// content contains a placeholder the pack author
			// declared unacceptable. The recipe writes a
			// `src/index.ts` containing the placeholder so the
			// validator reports `error: true` and the layer
			// fails. The verdict text must surface the
			// validator's diagnostic verbatim.
			await stack.git.commitManifest({
				name: "@acme/rejects",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "m",
				packValidators: ["rejectsPlaceholder"],
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["src/index.ts"],
						body: `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("src/index.ts", "PLACEHOLDER-FORBIDDEN")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`,
					},
				],
				extras: [
					{
						path: "_shared/validators/rejects-placeholder.ts",
						content: `
import { readFileSync } from "node:fs"
import { join } from "node:path"
export async function rejectsPlaceholder(state) {
  const out = []
  function walk(dir) {
    let entries
    try {
      entries = require("node:fs").readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        try {
          const text = readFileSync(full, "utf8")
          if (text.includes("PLACEHOLDER-FORBIDDEN")) {
            out.push({ severity: "error", rule: "rejectsPlaceholder", message: "forbidden placeholder in " + full, file: full })
          }
        } catch {}
      }
    }
  }
  walk(state.targetDirectory)
  return out
}
`,
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
					packPath: "m",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			const detail = await stack.fx.app.request("/v1/packs/acme/rejects/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					outputValidation: {
						ok: boolean
						step?: string
						validators?: { packValidators: Array<{ validatorId: string; diagnostics: unknown[] }> }
						failure?: { step: string; message: string; diagnostics?: unknown[] }
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			expect(body.screening?.outputValidation?.ok).toBe(false)
			expect(body.screening?.outputValidation?.step ?? body.screening?.outputValidation?.failure?.step).toBe(
				"validator",
			)
			// The validator's diagnostic is surfaced (the
			// message names the file and the rule).
			const packValidator =
				body.screening?.outputValidation?.validators?.packValidators?.[0] ??
				body.screening?.outputValidation?.failure?.diagnostics?.[0]
			expect(JSON.stringify(packValidator ?? "")).toMatch(/PLACEHOLDER-FORBIDDEN|rejectsPlaceholder/)
		})

		it("a control fixture whose validators pass screens to `screened`", async () => {
			// Same validator as above, but the recipe writes a
			// file that does NOT contain the placeholder.
			await stack.git.commitManifest({
				name: "@acme/cleanval",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "m",
				packValidators: ["rejectsPlaceholder"],
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["src/index.ts"],
						body: `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("src/index.ts", "console.log('hello')")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`,
					},
				],
				extras: [
					{
						path: "_shared/validators/rejects-placeholder.ts",
						content: `
import { readFileSync } from "node:fs"
import { join } from "node:path"
export async function rejectsPlaceholder(state) {
  const out = []
  function walk(dir) {
    let entries
    try {
      entries = require("node:fs").readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        try {
          const text = readFileSync(full, "utf8")
          if (text.includes("PLACEHOLDER-FORBIDDEN")) {
            out.push({ severity: "error", rule: "rejectsPlaceholder", message: "forbidden placeholder in " + full, file: full })
          }
        } catch {}
      }
    }
  }
  walk(state.targetDirectory)
  return out
}
`,
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
					packPath: "m",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = await stack.fx.app.request("/v1/packs/acme/cleanval/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					outputValidation: { ok: boolean; validators?: { packValidators: unknown[] } } | null
				} | null
			}
			expect(body.screening?.verdict).toBe("screened")
			expect(body.screening?.outputValidation?.ok).toBe(true)
			expect(body.screening?.outputValidation?.validators?.packValidators).toBeDefined()
		})

		it("a per-recipe validator runs against the dry-run output and reports recipe diagnostics", async () => {
			// A recipe-level validator that flags `src/index.ts`
			// containing the placeholder. The validator runs
			// against the dry-run output for the recipe and
			// receives the recipe's compensationData (the
			// engine contract — pinned by the validator.ts
			// implementation in ast-tooling).
			await stack.git.commitManifest({
				name: "@acme/actionval",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "m",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["src/index.ts"],
						validators: ["rejectsPlaceholder"],
						body: `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("src/index.ts", "PLACEHOLDER-FORBIDDEN")
    return { success: true, output: undefined, compensationData: { files: ["src/index.ts"] } }
  },
  async compensate() {},
}
`,
					},
				],
				extras: [
					{
						path: "writer/validators/rejects-placeholder.ts",
						content: `
import { readFileSync } from "node:fs"
import { join } from "node:path"
export async function rejectsPlaceholder(state, _recipeData) {
  const out = []
  function walk(dir) {
    let entries
    try {
      entries = require("node:fs").readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        try {
          const text = readFileSync(full, "utf8")
          if (text.includes("PLACEHOLDER-FORBIDDEN")) {
            out.push({ severity: "error", rule: "rejectsPlaceholder", message: "forbidden placeholder in " + full, file: full })
          }
        } catch {}
      }
    }
  }
  walk(state.targetDirectory)
  return out
}
`,
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
					packPath: "m",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			const detail = await stack.fx.app.request("/v1/packs/acme/actionval/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					outputValidation: { ok: boolean; step?: string } | null
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			expect(body.screening?.outputValidation?.ok).toBe(false)
			expect(body.screening?.outputValidation?.step).toBe("validator")
		})
	})

	describe("writes-subset-filePatterns (VAL-SCAN-007)", () => {
		it("a computed-path write outside declared filePatterns fails the layer (layer 1 cannot see this)", async () => {
			// The recipe's write path is COMPOSED at runtime
			// via the test canary channel (BAKA_DRYRUN_TEST_CANARY_CONFIG
			// in the parent → `--canary-config` argv →
			// <sandboxDir>/_canary.json in the subprocess), so
			// layer 1's static scanner cannot detect it as a
			// literal write-outside-patterns. Architecture §8
			// decision 39 scrubs the spawn env, so previous
			// `process.env` passthrough no longer reaches the
			// recipe. The recipe declares
			// `filePatterns: ["src/index.ts"]` but writes to
			// `escape.txt` at the sandbox root. Layer 3 must
			// catch this by comparing the actual rendered
			// preview file's path against the declared patterns.
			process.env.BAKA_DRYRUN_TEST_CANARY_CONFIG = JSON.stringify({
				outPattern: "escape.txt",
			})
			await stack.git.commitManifest({
				name: "@acme/ofp",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "m",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["src/index.ts"],
						body: `
import { readFileSync, writeFileSync } from "node:fs"
const canaryConfig = JSON.parse(readFileSync('_canary.json', 'utf8'))
const outPattern = canaryConfig.outPattern
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("src/index.ts", "ok")
    writeFileSync(outPattern, "leaked")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`,
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
					packPath: "m",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("failed")

			const detail = await stack.fx.app.request("/v1/packs/acme/ofp/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					outputValidation: {
						ok: boolean
						step?: string
						failure?: { step: string; message: string; path?: string }
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			expect(body.screening?.outputValidation?.ok).toBe(false)
			expect(body.screening?.outputValidation?.step).toBe("writes-subset")
			expect(body.screening?.outputValidation?.failure?.path).toBe("escape.txt")
			expect(body.screening?.outputValidation?.failure?.message ?? "").toMatch(/escape\.txt/)
		})

		it("the FIXTURE_OK control passes this check (writes ⊆ declared filePatterns)", async () => {
			// The control recipe writes only to declared
			// `filePatterns`. Layer 3 passes and the version
			// reaches `screened` (assuming no other layer
			// failed).
			await stack.git.commitManifest({
				name: "@acme/ok",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "m",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["src/index.ts"],
						body: `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("src/index.ts", "ok")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`,
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
					packPath: "m",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")
		})
	})

	describe("output toolchain (VAL-SCAN-017)", () => {
		it("a recipe declaring `toolchain: 'tsc'` whose output fails tsc --noEmit fails the layer with surfaced diagnostics", async () => {
			// The recipe writes a TypeScript file with a
			// deliberate type error, declares `toolchain: 'tsc'`.
			// Layer 3 runs `tsc --noEmit` against the validation
			// dir; the diagnostic must surface verbatim in the
			// output_validation.failure record.
			const tscfg = JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ES2022",
					module: "ESNext",
					noEmit: true,
					skipLibCheck: true,
				},
				include: ["src"],
			})
			const brokenTs = "export const x: number = 'string-not-number';\n"
			await stack.git.commitManifest({
				name: "@acme/tscfail",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "m",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["src/index.ts", "tsconfig.json"],
						toolchain: "tsc",
						body: `
import { writeFileSync, mkdirSync } from "node:fs"
const broken = ${JSON.stringify(brokenTs)}
const tscfg = ${JSON.stringify(tscfg)}
export default {
  name: "writer",
  role: 1,
  async execute() {
    mkdirSync("src", { recursive: true })
    writeFileSync("src/index.ts", broken)
    writeFileSync("tsconfig.json", tscfg)
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`,
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
					packPath: "m",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId, { timeoutMs: 60_000 })
			expect(terminal.status).toBe("failed")

			const detail = await stack.fx.app.request("/v1/packs/acme/tscfail/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					outputValidation: {
						ok: boolean
						step?: string
						failure?: { step: string; recipeId: string; toolchain: string; exitCode: number; stderr: string }
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("failed")
			expect(body.screening?.outputValidation?.ok).toBe(false)
			expect(body.screening?.outputValidation?.step).toBe("toolchain")
			expect(body.screening?.outputValidation?.failure?.toolchain).toBe("tsc")
			expect(body.screening?.outputValidation?.failure?.recipeId).toBe("writer")
			expect(body.screening?.outputValidation?.failure?.exitCode).not.toBe(0)
			// The tsc stderr mentions the type error path and the
			// offending literal so the verdict text quotes the
			// actual diagnostic (not a generic "toolchain failed").
			expect(body.screening?.outputValidation?.failure?.stderr ?? "").toMatch(/index\.ts|number|string/)
		})

		it("a control fixture whose TS output compiles cleanly passes this check", async () => {
			// The recipe writes a clean TypeScript file +
			// tsconfig.json, declares `toolchain: 'tsc'`.
			// Layer 3 runs `tsc --noEmit` and the version
			// screens to `screened`.
			const tscfg = JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ES2022",
					module: "ESNext",
					noEmit: true,
					skipLibCheck: true,
				},
				include: ["src"],
			})
			const cleanTs = "export const x: number = 42;\nexport function main(): void { console.log(x); }\nmain();\n"
			await stack.git.commitManifest({
				name: "@acme/tscpass",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "m",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["src/index.ts", "tsconfig.json"],
						toolchain: "tsc",
						body: `
import { writeFileSync, mkdirSync } from "node:fs"
const clean = ${JSON.stringify(cleanTs)}
const tscfg = ${JSON.stringify(tscfg)}
export default {
  name: "writer",
  role: 1,
  async execute() {
    mkdirSync("src", { recursive: true })
    writeFileSync("src/index.ts", clean)
    writeFileSync("tsconfig.json", tscfg)
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`,
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
					packPath: "m",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId, { timeoutMs: 60_000 })
			expect(terminal.status).toBe("ready")

			const detail = await stack.fx.app.request("/v1/packs/acme/tscpass/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: {
					verdict: string
					outputValidation: {
						ok: boolean
						toolchains?: Array<{ recipeId: string; toolchain: string; exitCode: number }>
					} | null
				} | null
			}
			expect(body.screening?.verdict).toBe("screened")
			expect(body.screening?.outputValidation?.ok).toBe(true)
			expect(body.screening?.outputValidation?.toolchains).toBeDefined()
			expect(body.screening?.outputValidation?.toolchains?.[0]?.exitCode).toBe(0)
		})

		it("a recipe without `toolchain` declared does NOT trigger tsc and skips silently", async () => {
			// No toolchain declared → no tsc invocation, no
			// toolchains record on success.
			await stack.git.commitManifest({
				name: "@acme/notsc",
				version: "1.0.0",
				tag: "v1.0.0",
				packPath: "m",
				recipes: [
					{
						id: "writer",
						description: "writer",
						filePatterns: ["src/index.ts"],
						body: `
import { writeFileSync } from "node:fs"
export default {
  name: "writer",
  role: 1,
  async execute() {
    writeFileSync("src/index.ts", "ok")
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`,
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
					packPath: "m",
				}),
			})
			const { versionId } = (await res.json()) as { versionId: string }
			const terminal = await stack.fx.waitForTerminal(versionId)
			expect(terminal.status).toBe("ready")

			const detail = await stack.fx.app.request("/v1/packs/acme/notsc/v1.0.0", {
				headers: { "x-api-key": stack.fx.keys.owner },
			})
			const body = (await detail.json()) as {
				screening: { outputValidation: { ok: boolean; toolchains?: unknown[] } | null } | null
			}
			expect(body.screening?.outputValidation?.ok).toBe(true)
			// No toolchain record when none declared.
			expect(body.screening?.outputValidation?.toolchains ?? []).toEqual([])
		})
	})
})

// Touch the unused imports so biome does not flag them.
void beforeEach
void afterEach
