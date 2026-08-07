import { spawn } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ModuleManifest, OrchestrationState, ValidationDiagnostic } from "@repo/protocol"
import { createJiti } from "jiti"
import type { StorageAdapter } from "../storage"
import type { PerActionState } from "./dry-run"

/**
 * Screening output-validation (architecture §4.6 layer 3,
 * VAL-SCAN-006 / 007 / 017).
 *
 * Three sub-layers run after the dry-run (layer 2) completes:
 *
 *   1. Module's own validators — load every validator the
 *      manifest declares (`moduleValidators` + `action.validators`)
 *      from the module's own tree, run them against the
 *      materialized dry-run output, collect diagnostics.
 *      Validator errors fail the layer with the rule's diagnostic
 *      surfaced verbatim on `output_validation.failure`.
 *
 *   2. Writes-subset-filePatterns — for every rendered preview
 *      file produced by layer 2, verify its relative path is
 *      covered by the action's declared `filePatterns`. This is
 *      the runtime complement to layer 1's static detection
 *      (layer 1 catches string-literal writes; layer 3 catches
 *      computed-path writes the static scanner cannot see). An
 *      off-pattern write names the offending path on
 *      `output_validation.failure`.
 *
 *   3. Output toolchain — for actions that declare
 *      `toolchain: 'tsc'`, run `tsc --noEmit` against the
 *      validation dir and surface the diagnostic verbatim on
 *      failure. The closed `tsc` set is deliberate: the
 *      registry stays honest about which tools it runs and how
 *      their failures are surfaced.
 *
 * Verdict routing (decision: layer 3 routes through the
 * dry-run verdict path in `ingest.ts`):
 *
 *   - All three pass     → verdict `screened` (overall).
 *   - Any sub-layer fail → verdict `failed` with the layer's
 *                          `step` discriminator + the failure
 *                          surface (validator diagnostics,
 *                          off-pattern write path, or tsc
 *                          diagnostic).
 *
 * Own-tree-only policy (VAL-SCAN-014) is unchanged: validators
 * see the dry-run output dir as their `targetDirectory`, and
 * the toolchain runs against that same dir. Manifest
 * dependencies are NOT fetched or installed by the screening
 * system.
 *
 * Validator subprocess isolation: validators are loaded via
 * jiti (the same loader used for actions in the dry-run
 * subprocess). They are then invoked in-process by the worker;
 * the static scan has already denied network APIs / child_process
 * / eval in the module's own tree, so an in-process validator
 * cannot bypass the screening gates. The validator file is
 * trusted because the loadability gate
 * (`packages/ast-tooling/src/action-loader.ts:81-117` /
 * `apps/registry/src/worker/manifest.ts`) requires the file to
 * exist and to export a function.
 */

const VALIDATION_DIR_PREFIX = "baka-output-validation-"

interface ValidatorSummary {
	validatorId: string
	path: string
	diagnostics: ValidationDiagnostic[]
}

export interface OutputValidationResultSuccess {
	ok: true
	validators: {
		moduleValidators: ValidatorSummary[]
		actionValidators: ValidatorSummary[]
	}
	writesSubset: true
	toolchains: Array<{
		actionId: string
		toolchain: "tsc"
		exitCode: number
		ok: boolean
	}>
}

export interface OutputValidationResultFailure {
	ok: false
	step: "validator" | "writes-subset" | "toolchain"
	failure: {
		step: "validator" | "writes-subset" | "toolchain"
		/** Module-level validator id that failed, when step=validator. */
		validatorId?: string
		/** "module" | "action" — the validator scope. */
		validatorScope?: "module" | "action"
		/** Action id, when step=validator on an action validator. */
		actionId?: string
		/** The validator's surfaced diagnostics. */
		diagnostics?: ValidationDiagnostic[]
		/** Off-pattern write path, when step=writes-subset. */
		path?: string
		/** Toolchain details, when step=toolchain. */
		toolchain?: "tsc"
		exitCode?: number
		/** Toolchain stderr verbatim (capped). */
		stderr?: string
		/** Short message describing the failure. */
		message: string
	}
}

export type OutputValidationPayload = OutputValidationResultSuccess | OutputValidationResultFailure

interface RunOutputValidationOptions {
	moduleDir: string
	manifest: ModuleManifest
	perAction: PerActionState[]
	storage: StorageAdapter
	jitiRoot?: string
	/** Per-toolchain timeout in milliseconds (default 30s). */
	toolchainTimeoutMs?: number
}

export async function runOutputValidation(opts: RunOutputValidationOptions): Promise<OutputValidationPayload> {
	const jitiRoot = opts.jitiRoot ?? findJitiRoot(opts.moduleDir)
	const moduleReal = realpathSync(opts.moduleDir)

	// Materialize the dry-run output into a fresh validation dir.
	// One subdir per action; per-action preview files land under
	// `<validationDir>/<actionId>/`. The subdir matches the
	// action's relative file paths so validators and the
	// declared toolchain see the same paths the action wrote.
	const validationDir = await mkdtemp(join(tmpdir(), VALIDATION_DIR_PREFIX))

	const moduleValidatorResults: ValidatorSummary[] = []
	const actionValidatorResults: ValidatorSummary[] = []
	const toolchainResults: OutputValidationResultSuccess["toolchains"] = []

	try {
		// Materialize preview files for every screened action.
		// The narrow type lets TS see `previewFiles` is defined
		// when we iterate the materialized entries below.
		type ScreenedActionState = Extract<PerActionState, { status: "screened" }>
		const actionMaterialized: Array<{ actionId: string; state: ScreenedActionState }> = []
		for (const state of opts.perAction) {
			if (state.status !== "screened") continue
			const actionSubdir = join(validationDir, state.actionId)
			mkdirSync(actionSubdir, { recursive: true })
			for (const file of state.previewFiles) {
				const bytes = await opts.storage.get(file.storageKey)
				if (bytes === null) {
					throw new Error(`preview file storage key ${file.storageKey} not found for action ${state.actionId}`)
				}
				const target = join(actionSubdir, file.path)
				mkdirSync(join(target, ".."), { recursive: true })
				writeFileSync(target, bytes)
			}
			actionMaterialized.push({ actionId: state.actionId, state })
		}

		// -----------------------------------------------------------------
		// Sub-layer 1: module's own validators (VAL-SCAN-006)
		// -----------------------------------------------------------------
		// Module validators run against the whole validation dir.
		// The validator's contract is `async (state) => Diagnostic[]`
		// where `state.targetDirectory` is the dir to scan — the
		// same contract `runValidators` in
		// `packages/ast-tooling/src/validator.ts` honors.
		const moduleValidatorIds = opts.manifest.moduleValidators ?? []
		for (const validatorId of moduleValidatorIds) {
			const summary = await invokeModuleValidator({
				moduleReal,
				jitiRoot,
				validatorId,
				targetDirectory: validationDir,
			})
			moduleValidatorResults.push(summary)
			const errors = summary.diagnostics.filter((d) => d.severity === "error")
			if (errors.length > 0) {
				return {
					ok: false,
					step: "validator",
					failure: {
						step: "validator",
						validatorScope: "module",
						validatorId,
						diagnostics: errors,
						message: `module validator '${validatorId}' reported ${errors.length} error(s) against dry-run output`,
					},
				}
			}
		}

		// Per-action validators run against the action's subdir so
		// the validator sees only that action's produced files.
		// The engine contract passes the action's `compensationData`
		// as the second argument (`runValidators` does the same).
		for (const { actionId, state } of actionMaterialized) {
			const action = opts.manifest.actions.find((a) => a.id === actionId)
			if (action === undefined) continue
			const validatorIds = action.validators ?? []
			for (const validatorId of validatorIds) {
				const summary = await invokeActionValidator({
					moduleReal,
					jitiRoot,
					actionId,
					validatorId,
					targetDirectory: join(validationDir, actionId),
					actionData: state,
				})
				actionValidatorResults.push(summary)
				const errors = summary.diagnostics.filter((d) => d.severity === "error")
				if (errors.length > 0) {
					return {
						ok: false,
						step: "validator",
						failure: {
							step: "validator",
							validatorScope: "action",
							validatorId,
							actionId,
							diagnostics: errors,
							message: `action validator '${actionId}:${validatorId}' reported ${errors.length} error(s) against dry-run output`,
						},
					}
				}
			}
		}

		// -----------------------------------------------------------------
		// Sub-layer 2: writes-subset-filePatterns (VAL-SCAN-007)
		// -----------------------------------------------------------------
		// For every rendered preview file, check that its
		// relative path (within the action's subdir) is covered
		// by the action's declared `filePatterns`. The path
		// match is exact-prefix: a declared `src/index.ts`
		// matches both `src/index.ts` and `src/index.ts/extra`
		// (the prefix-list shape the static scanner enforces).
		// The check covers computed-path writes that the static
		// scanner cannot see (layer 1 only flags string-literal
		// arguments to writeFile-like calls).
		for (const { actionId, state } of actionMaterialized) {
			const action = opts.manifest.actions.find((a) => a.id === actionId)
			if (action === undefined) continue
			const allowed = new Set<string>(action.filePatterns)
			for (const file of state.previewFiles) {
				const normalized = file.path.replace(/\\/g, "/").replace(/^\.\//, "")
				if (matchesAllowedPattern(normalized, allowed)) continue
				return {
					ok: false,
					step: "writes-subset",
					failure: {
						step: "writes-subset",
						path: file.path,
						actionId,
						message: `action '${actionId}' wrote '${file.path}' which is outside its declared filePatterns [${[...allowed].join(", ")}]`,
					},
				}
			}
		}

		// -----------------------------------------------------------------
		// Sub-layer 3: output toolchain (VAL-SCAN-017)
		// -----------------------------------------------------------------
		// For each action that declares `toolchain: 'tsc'`, run
		// `tsc --noEmit` against the action's subdir and surface
		// the diagnostic verbatim on failure. The closed `tsc`
		// set is intentional: the registry stays honest about
		// which tools it runs.
		const toolchainTimeoutMs = opts.toolchainTimeoutMs ?? 30_000
		for (const { actionId } of actionMaterialized) {
			const action = opts.manifest.actions.find((a) => a.id === actionId)
			if (action === undefined) continue
			if (action.toolchain !== "tsc") continue
			const actionSubdir = join(validationDir, actionId)
			const result = await runTscNoEmit({ targetDir: actionSubdir, timeoutMs: toolchainTimeoutMs })
			toolchainResults.push({
				actionId,
				toolchain: "tsc",
				exitCode: result.exitCode,
				ok: result.ok,
			})
			if (!result.ok) {
				return {
					ok: false,
					step: "toolchain",
					failure: {
						step: "toolchain",
						toolchain: "tsc",
						actionId,
						exitCode: result.exitCode,
						stderr: result.stderr,
						message: `tsc --noEmit failed for action '${actionId}' with exit code ${result.exitCode}`,
					},
				}
			}
		}

		return {
			ok: true,
			validators: {
				moduleValidators: moduleValidatorResults,
				actionValidators: actionValidatorResults,
			},
			writesSubset: true,
			toolchains: toolchainResults,
		}
	} finally {
		// Cleanup the validation dir on every path (success /
		// failure). The bytes live in the storage adapter (we
		// read from there); the validation dir is purely
		// ephemeral.
		try {
			rmSync(validationDir, { recursive: true, force: true })
		} catch {
			// best effort
		}
	}
}

/**
 * Loads a module-level validator from the module's own tree
 * and invokes it against `targetDirectory`. The validator file
 * is trusted: the loadability gate
 * (`apps/registry/src/worker/manifest.ts`) requires the file to
 * exist; the static scan denied network APIs / child_process /
 * eval in the module's own tree.
 *
 * Mirrors `loadModuleValidator` in
 * `packages/ast-tooling/src/action-loader.ts:81-87`:
 *   path = `<moduleRoot>/_shared/validators/<kebabId>.ts`
 *   export = `mod[validatorId] ?? mod.default`
 */
async function invokeModuleValidator(opts: {
	moduleReal: string
	jitiRoot: string
	validatorId: string
	targetDirectory: string
}): Promise<ValidatorSummary> {
	const validatorPath = join(opts.moduleReal, "_shared", "validators", `${kebabCase(opts.validatorId)}.ts`)
	if (!existsSync(validatorPath)) {
		throw new Error(`module validator '${opts.validatorId}' file not found at ${validatorPath}`)
	}
	const jiti = createJiti(opts.jitiRoot, { interopDefault: true })
	const mod = jiti(validatorPath) as Record<string, unknown>
	const fn = (mod[opts.validatorId] ?? mod.default) as
		| ((state: OrchestrationState) => Promise<ValidationDiagnostic[]>)
		| undefined
	if (typeof fn !== "function") {
		throw new Error(
			`module validator '${opts.validatorId}' must export a function named '${opts.validatorId}' (or as default)`,
		)
	}
	const diagnostics = await safeInvokeValidator(fn, opts.targetDirectory)
	return { validatorId: opts.validatorId, path: validatorPath, diagnostics }
}

/**
 * Loads an action-level validator from the module's own tree
 * and invokes it against `targetDirectory` with `actionData` as
 * the second argument. Mirrors `loadActionValidator` in
 * `packages/ast-tooling/src/action-loader.ts:103-117`:
 *   path = `<moduleRoot>/<actionId>/validators/<kebabId>.ts`
 *   export = `mod[validatorId] ?? mod.default`
 */
async function invokeActionValidator(opts: {
	moduleReal: string
	jitiRoot: string
	actionId: string
	validatorId: string
	targetDirectory: string
	actionData: unknown
}): Promise<ValidatorSummary> {
	const validatorPath = join(opts.moduleReal, opts.actionId, "validators", `${kebabCase(opts.validatorId)}.ts`)
	if (!existsSync(validatorPath)) {
		throw new Error(`action validator '${opts.actionId}:${opts.validatorId}' file not found at ${validatorPath}`)
	}
	const jiti = createJiti(opts.jitiRoot, { interopDefault: true })
	const mod = jiti(validatorPath) as Record<string, unknown>
	const fn = (mod[opts.validatorId] ?? mod.default) as
		| ((state: OrchestrationState, actionData: unknown) => Promise<ValidationDiagnostic[]>)
		| undefined
	if (typeof fn !== "function") {
		throw new Error(
			`action validator '${opts.validatorId}' must export a function named '${opts.validatorId}' (or as default)`,
		)
	}
	const diagnostics = await safeInvokeActionValidator(fn, opts.targetDirectory, opts.actionData)
	return { validatorId: opts.validatorId, path: validatorPath, diagnostics }
}

async function safeInvokeValidator(
	fn: (state: OrchestrationState) => Promise<ValidationDiagnostic[]>,
	targetDirectory: string,
): Promise<ValidationDiagnostic[]> {
	const state: OrchestrationState = makeOrchestrationState(targetDirectory)
	try {
		const out = await fn(state)
		return Array.isArray(out) ? out : []
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return [{ severity: "error", rule: "validator-threw", message: msg }]
	}
}

async function safeInvokeActionValidator(
	fn: (state: OrchestrationState, actionData: unknown) => Promise<ValidationDiagnostic[]>,
	targetDirectory: string,
	actionData: unknown,
): Promise<ValidationDiagnostic[]> {
	const state: OrchestrationState = makeOrchestrationState(targetDirectory)
	try {
		const out = await fn(state, actionData)
		return Array.isArray(out) ? out : []
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return [{ severity: "error", rule: "validator-threw", message: msg }]
	}
}

function makeOrchestrationState(targetDirectory: string): OrchestrationState {
	// Minimal OrchestrationState. The validator contract reads
	// `state.targetDirectory` to locate the dir to scan; the
	// other fields are placeholders so the validator's
	// `state.status` writes (which the engine contract
	// tolerates) don't crash.
	return {
		userIntent: "",
		targetDirectory,
		status: "VALIDATING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
}

interface TscResult {
	ok: boolean
	exitCode: number
	stderr: string
}

/**
 * Runs `npx tsc --noEmit` against the target dir. The registry
 * does not bundle its own tsc; it shells out so the toolchain
 * the action declared (and the rest of the project's
 * toolchain) is the one being tested.
 *
 * `npx` finds `tsc` via the parent PATH / workspace
 * `node_modules/.bin`. We spawn `node` directly with the
 * project's tsc.js entry to avoid the npx wrapper noise
 * (npm warnings about unknown env configs) that would mask
 * the actual tsc diagnostic in the verdict text.
 *
 * The command's `cwd` is set to the action's subdir so
 * `tsconfig.json` resolution follows the local config.
 */
function runTscNoEmit(opts: { targetDir: string; timeoutMs: number }): Promise<TscResult> {
	return new Promise((resolve) => {
		// Use `process.execPath` (this Node binary) to run the
		// project's tsc entry directly. The registry process
		// has typescript in its own node_modules (it ships a
		// dev dep on `typescript` for the AST scanner), so the
		// require path is stable across workspaces.
		//
		// ESM context: `apps/registry` is `"type": "module"`
		// and the dev server runs under `tsx`, where `require`
		// is undefined. `createRequire(import.meta.url)`
		// manufactures a CJS-shaped `require` from a known
		// file URL — the same pattern `dry-run.ts:772` uses
		// to resolve `jiti`. Bare `require.resolve(...)`
		// works only when a test runner (vitest) injects a
		// require shim, masking the production crash that
		// user-testing round 1 surfaced (VAL-SCAN-017).
		const tscEntry = createRequire(import.meta.url).resolve("typescript/bin/tsc")
		const child = spawn(process.execPath, [tscEntry, "--noEmit"], {
			cwd: opts.targetDir,
			env: { ...process.env, NODE_OPTIONS: "" },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stderrBuf = ""
		let stdoutBuf = ""
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString("utf8")
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString("utf8")
		})

		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL")
			} catch {
				// already dead
			}
			resolve({
				ok: false,
				exitCode: -1,
				stderr: `tsc --noEmit exceeded ${opts.timeoutMs}ms; stderr so far: ${stderrBuf}`.slice(0, 4_000),
			})
		}, opts.timeoutMs)

		child.on("error", (err) => {
			clearTimeout(timer)
			resolve({ ok: false, exitCode: -1, stderr: `tsc --noEmit spawn failed: ${err.message}` })
		})
		child.on("close", (code, signal) => {
			clearTimeout(timer)
			const exitCode = code ?? (signal === "SIGKILL" ? -1 : 1)
			if (exitCode === 0) {
				resolve({ ok: true, exitCode, stderr: "" })
				return
			}
			// tsc reports the type errors on stdout (it writes
			// them as `${file}(${line},${col}): error ${TSxxxx}:
			// ${message}` per line). Surface both streams so the
			// verdict text quotes the actual diagnostic.
			const combined = (stdoutBuf + stderrBuf).slice(0, 4_000)
			resolve({ ok: false, exitCode, stderr: combined })
		})
	})
}

function matchesAllowedPattern(path: string, allowed: ReadonlySet<string>): boolean {
	if (allowed.has(path)) return true
	for (const pattern of allowed) {
		if (path === pattern) return true
		if (path.startsWith(`${pattern}/`)) return true
	}
	return false
}

function kebabCase(id: string): string {
	return id.replace(/[A-Z]/g, (m, offset) => (offset > 0 ? "-" : "") + m.toLowerCase())
}

/**
 * Walks up from `start` looking for the closest `node_modules/`.
 * Returns the parent of `node_modules/` (the directory jiti will
 * use for module resolution). Same semantics as the dry-run's
 * `findJitiRoot`; duplicated here so layer 3 has its own
 * explicit dependency without dragging the dry-run's surface.
 */
function findJitiRoot(start: string): string {
	let cur = start
	for (let i = 0; i < 8; i++) {
		const candidate = join(cur, "node_modules")
		if (existsSync(candidate)) return cur
		const parent = dirname(cur)
		if (parent === cur) break
		cur = parent
	}
	return process.cwd()
}
