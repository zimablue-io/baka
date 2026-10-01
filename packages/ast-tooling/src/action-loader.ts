import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ActionStep, ModuleManifest, OrchestrationState, ValidationDiagnostic } from "@repo/protocol"
import { createJiti } from "jiti"

/**
 * Convert a camelCase validator id (e.g. "hasPackageJson") to its kebab-case
 * filename stem (e.g. "has-package-json"). Validator ids stay camelCase in
 * manifests (matching JS function names) but live as kebab-case .ts files
 * on disk (matching the codebase's filename convention).
 */
function validatorFilename(id: string): string {
	return id.replace(/[A-Z]/g, (m, offset) => (offset > 0 ? "-" : "") + m.toLowerCase())
}

export interface LoadedAction<TInput, TOutput, TCompensationData> {
	step: ActionStep<TInput, TOutput, TCompensationData>
	manifest: ModuleManifest
	actionId: string
}

/**
 * Loads an action from disk via jiti. The action file is the actioner's
 * source of truth: it owns its params, its execute, and its compensate.
 *
 * The action file is expected to export either:
 *   - a single ActionStep value named `${actionId}Action`, or
 *   - the default export, treated as the ActionStep.
 *
 * jiti is used so that the action file can be authored in TypeScript with
 * full type-safety against baka-sdk, without a separate build step. The
 * file may import types from `baka-sdk` (`import type`, erased at load
 * time) but nothing at run time: `baka-sdk` is not installed next to a
 * module, and `baka module validate` rejects a runtime import of it.
 */
export function loadAction<TInput, TOutput, TCompensationData>(
	_projectRoot: string,
	moduleRoot: string,
	manifest: ModuleManifest,
	actionId: string,
): LoadedAction<TInput, TOutput, TCompensationData> {
	const actionPath = join(moduleRoot, actionId, "action.ts")
	if (!existsSync(actionPath)) {
		throw new Error(`action file not found: ${actionPath}`)
	}
	const jiti = createJiti(moduleRoot, { interopDefault: true })
	const mod = jiti(actionPath) as Record<string, unknown>
	// Resolution order (architecture §3.1):
	//   camelCase(id), camelCase(id)+"Action", exact id, id+"Action", "default".
	// This lets hyphenated ids like `add-script` resolve to `addScriptAction`.
	const camelCaseId = toCamelCase(actionId)
	const candidates = [camelCaseId, `${camelCaseId}Action`, `${actionId}`, `${actionId}Action`, "default"]
	let step: ActionStep<TInput, TOutput, TCompensationData> | undefined
	for (const name of candidates) {
		const c = mod[name] as { execute?: unknown; compensate?: unknown } | undefined
		if (c && typeof c.execute === "function" && typeof c.compensate === "function") {
			step = c as ActionStep<TInput, TOutput, TCompensationData>
			break
		}
	}
	if (!step) {
		throw new Error(
			`action file ${actionPath} must export an ActionStep value named \`${camelCaseId}\`, \`${camelCaseId}Action\`, \`${actionId}\`, \`${actionId}Action\`, or as the default export`,
		)
	}
	return { step, manifest, actionId }
}

function toCamelCase(id: string): string {
	return id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/**
 * Loads a module-level validator (a function that takes a state and returns
 * a list of diagnostics). Used by `baka validate`.
 */
export type ModuleValidatorFn = (
	state: OrchestrationState,
) => Promise<Array<{ severity: "error" | "warning"; rule: string; message: string }>>

export function loadModuleValidator(_projectRoot: string, moduleRoot: string, validatorId: string): ModuleValidatorFn {
	const path = join(moduleRoot, "_shared", "validators", `${validatorFilename(validatorId)}.ts`)
	if (!existsSync(path)) {
		throw new Error(`module validator not found: ${path}`)
	}
	const jiti = createJiti(moduleRoot, { interopDefault: true })
	const mod = jiti(path) as Record<string, unknown>
	const fn = (mod[validatorId] ?? mod.default) as ModuleValidatorFn | undefined
	if (typeof fn !== "function") {
		throw new Error(`validator file ${path} must export a function named \`${validatorId}\` (or as the default export)`)
	}
	return fn
}

/**
 * Loads an action-level validator. These live at
 * `<moduleRoot>/<actionId>/validators/<validatorId>.ts` and run after the
 * action completes, with access to the state so they can assert
 * post-execution invariants against the produced files.
 */
export type ActionValidatorFn = (state: OrchestrationState, actionData: unknown) => Promise<ValidationDiagnostic[]>

export function loadActionValidator(
	_projectRoot: string,
	moduleRoot: string,
	actionId: string,
	validatorId: string,
): ActionValidatorFn {
	const path = join(moduleRoot, actionId, "validators", `${validatorFilename(validatorId)}.ts`)
	if (!existsSync(path)) {
		throw new Error(`action validator not found: ${path}`)
	}
	const jiti = createJiti(moduleRoot, { interopDefault: true })
	const mod = jiti(path) as Record<string, unknown>
	const fn = (mod[validatorId] ?? mod.default) as ActionValidatorFn | undefined
	if (typeof fn !== "function") {
		throw new Error(`validator file ${path} must export a function named \`${validatorId}\` (or as the default export)`)
	}
	return fn
}
