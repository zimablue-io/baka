import { existsSync } from "node:fs"
import { join } from "node:path"
import { createJiti } from "jiti"
import type { ModuleManifest, StepResponse, WorkflowStep, OrchestrationState, ValidationDiagnostic } from "@repo/protocol"

export interface LoadedAction<TInput, TOutput, TCompensationData> {
	step: WorkflowStep<TInput, TOutput, TCompensationData>
	manifest: ModuleManifest
	actionId: string
}

/**
 * Loads an action from disk via jiti. The action file is the actioner's
 * source of truth: it owns its params, its execute, and its compensate.
 *
 * The action file is expected to export either:
 *   - a single WorkflowStep value named `${actionId}Action`, or
 *   - the default export, treated as the WorkflowStep.
 *
 * jiti is used so that the action file can be authored in TypeScript with
 * full type-safety against baka-sdk, without a separate build step. We set
 * the jiti cwd to the module root so that `import ... from "baka-sdk"`
 * resolves to the module's own node_modules (or, in this monorepo, to the
 * workspace symlink).
 */
export function loadAction<TInput, TOutput, TCompensationData>(
	projectRoot: string,
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
	const expectedName = `${actionId}Action`
	const candidate = mod[expectedName] ?? mod.default
	if (!candidate || typeof candidate !== "object") {
		throw new Error(`action file ${actionPath} must export a WorkflowStep value named \`${expectedName}\` (or as the default export)`)
	}
	const step = candidate as WorkflowStep<TInput, TOutput, TCompensationData>
	if (typeof step.execute !== "function" || typeof step.compensate !== "function") {
		throw new Error(`action file ${actionPath} does not conform to WorkflowStep (missing execute/compensate)`)
	}
	return { step, manifest, actionId }
}

/**
 * Loads a module-level validator (a function that takes a state and returns
 * a list of diagnostics). Used by `baka validate`.
 */
export interface ModuleValidatorFn {
	(state: OrchestrationState): Promise<Array<{ severity: "error" | "warning"; rule: string; message: string }>>
}

export function loadModuleValidator(projectRoot: string, moduleRoot: string, validatorId: string): ModuleValidatorFn {
	const path = join(moduleRoot, "_shared", "validators", `${validatorId}.ts`)
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
export interface ActionValidatorFn {
	(state: OrchestrationState, actionData: unknown): Promise<ValidationDiagnostic[]>
}

export function loadActionValidator(
	projectRoot: string,
	moduleRoot: string,
	actionId: string,
	validatorId: string,
): ActionValidatorFn {
	const path = join(moduleRoot, actionId, "validators", `${validatorId}.ts`)
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

/**
 * Loads a shared helper from `<moduleRoot>/_shared/helpers/<helperId>.ts`.
 * Helpers are plain TypeScript modules that action.ts files can import
 * via `import { foo } from "./_shared/helpers/<id>"` (jiti resolves the
 * relative path) or via `import { foo } from "<id>"` if the loader is
 * told where to look.
 */
export function loadSharedHelper<T = unknown>(
	projectRoot: string,
	moduleRoot: string,
	helperId: string,
): T {
	const path = join(moduleRoot, "_shared", "helpers", `${helperId}.ts`)
	if (!existsSync(path)) {
		throw new Error(`shared helper not found: ${path}`)
	}
	const jiti = createJiti(moduleRoot, { interopDefault: true })
	const mod = jiti(path) as Record<string, unknown>
	return (mod[helperId] ?? mod.default) as T
}
