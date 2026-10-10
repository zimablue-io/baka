import { existsSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState, PackManifest, RecipeStep, ValidationDiagnostic } from "@repo/protocol"
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

export interface LoadedRecipe<TInput, TOutput, TCompensationData> {
	step: RecipeStep<TInput, TOutput, TCompensationData>
	manifest: PackManifest
	recipeId: string
}

/**
 * Loads a recipe from disk via jiti. The recipe file is the actioner's
 * source of truth: it owns its params, its execute, and its compensate.
 *
 * The recipe file is expected to export either:
 *   - a single RecipeStep value named `${recipeId}Recipe`, or
 *   - the default export, treated as the RecipeStep.
 *
 * jiti is used so that the recipe file can be authored in TypeScript with
 * full type-safety against baka-sdk, without a separate build step. The
 * file may import types from `baka-sdk` (`import type`, erased at load
 * time) but nothing at run time: `baka-sdk` is not installed next to a
 * pack, and `baka pack validate` rejects a runtime import of it.
 */
export function loadRecipe<TInput, TOutput, TCompensationData>(
	_projectRoot: string,
	packRoot: string,
	manifest: PackManifest,
	recipeId: string,
): LoadedRecipe<TInput, TOutput, TCompensationData> {
	const recipePath = join(packRoot, recipeId, "recipe.ts")
	if (!existsSync(recipePath)) {
		throw new Error(`recipe file not found: ${recipePath}`)
	}
	const jiti = createJiti(packRoot, { interopDefault: true })
	const mod = jiti(recipePath) as Record<string, unknown>
	// Resolution order (architecture §3.1):
	//   camelCase(id), camelCase(id)+"Recipe", exact id, id+"Recipe", "default".
	// This lets hyphenated ids like `add-script` resolve to `addScriptRecipe`.
	const camelCaseId = toCamelCase(recipeId)
	const candidates = [camelCaseId, `${camelCaseId}Recipe`, `${recipeId}`, `${recipeId}Recipe`, "default"]
	let step: RecipeStep<TInput, TOutput, TCompensationData> | undefined
	for (const name of candidates) {
		const c = mod[name] as { execute?: unknown; compensate?: unknown } | undefined
		if (c && typeof c.execute === "function" && typeof c.compensate === "function") {
			step = c as RecipeStep<TInput, TOutput, TCompensationData>
			break
		}
	}
	if (!step) {
		throw new Error(
			`recipe file ${recipePath} must export an RecipeStep value named \`${camelCaseId}\`, \`${camelCaseId}Recipe\`, \`${recipeId}\`, \`${recipeId}Recipe\`, or as the default export`,
		)
	}
	return { step, manifest, recipeId }
}

function toCamelCase(id: string): string {
	return id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/**
 * Loads a pack-level validator (a function that takes a state and returns
 * a list of diagnostics). Used by `baka validate`.
 */
export type PackValidatorFn = (state: OrchestrationState) => Promise<ValidationDiagnostic[]>

export function loadPackValidator(_projectRoot: string, packRoot: string, validatorId: string): PackValidatorFn {
	const path = join(packRoot, "_shared", "validators", `${validatorFilename(validatorId)}.ts`)
	if (!existsSync(path)) {
		throw new Error(`pack validator not found: ${path}`)
	}
	const jiti = createJiti(packRoot, { interopDefault: true })
	const mod = jiti(path) as Record<string, unknown>
	const fn = (mod[validatorId] ?? mod.default) as PackValidatorFn | undefined
	if (typeof fn !== "function") {
		throw new Error(`validator file ${path} must export a function named \`${validatorId}\` (or as the default export)`)
	}
	return fn
}

/**
 * Loads a recipe-level validator. These live at
 * `<packRoot>/<recipeId>/validators/<validatorId>.ts`. They receive the
 * state, whose `run` field says which recipe run they are judging: the
 * params, the recipe's output and compensation data, the changeset, and
 * whether the recipe ran in this invocation (see `ValidatorRun`).
 */
export type RecipeValidatorFn = (state: OrchestrationState) => Promise<ValidationDiagnostic[]>

export function loadRecipeValidator(
	_projectRoot: string,
	packRoot: string,
	recipeId: string,
	validatorId: string,
): RecipeValidatorFn {
	const path = join(packRoot, recipeId, "validators", `${validatorFilename(validatorId)}.ts`)
	if (!existsSync(path)) {
		throw new Error(`recipe validator not found: ${path}`)
	}
	const jiti = createJiti(packRoot, { interopDefault: true })
	const mod = jiti(path) as Record<string, unknown>
	const fn = (mod[validatorId] ?? mod.default) as RecipeValidatorFn | undefined
	if (typeof fn !== "function") {
		throw new Error(`validator file ${path} must export a function named \`${validatorId}\` (or as the default export)`)
	}
	return fn
}
