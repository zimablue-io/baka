import {
	type ChangesetEntry,
	ENGINE_STATUS,
	type OrchestrationState,
	type PackManifest,
	type ValidationDiagnostic,
	type ValidationResult,
	type ValidatorRun,
} from "@repo/protocol"
import { matchGlobs } from "./glob.js"
import { loadPackValidator, loadRecipeValidator } from "./recipe-loader.js"
import type { PackRegistry } from "./registry.js"
import { listProjectFiles } from "./tree-hash.js"

/** One recipe that ran in this invocation, as validators see it in `state.run`. */
export interface RanRecipe {
	pack: string
	recipe: string
	/** The params the recipe ran with (normalized). */
	params: Record<string, unknown>
	/** What the recipe's `execute` returned as compensation data (template-only recipes: `{ written }`). */
	compensationData: unknown
	/** What the recipe's `execute` returned as output, else null. */
	output: unknown
	changeset: ChangesetEntry[]
}

/**
 * What to validate.
 *
 * - `recipes`: the recipes that ran in this invocation (a `runRecipe`, or the
 *   steps of an apply). Each ran recipe's own validators run with its
 *   `state.run`; the pack-level validators of each of those packs run
 *   once, with `state.run` describing the last recipe of that pack that
 *   ran. Nothing else is validated: a pack that did not run is not touched.
 * - `project`: `baka validate`. Pack-level validators run (for one pack,
 *   or all) with no `state.run`; a recipe's validators run only when the
 *   recipe declares a `marker` and a file in the project matches it, with
 *   `state.run.ran === false` and `state.run.detected` listing the matches.
 */
export type ValidationScope = { mode: "recipes"; ran: readonly RanRecipe[] } | { mode: "project"; pack?: string }

/**
 * Run the validators selected by `scope` and return every diagnostic they
 * (and discovery) produced, warnings included, whichever way the result goes:
 * `kind` is `fail` exactly when some diagnostic is an error.
 *
 * Each validator diagnostic keeps the validator's own `rule` (the validator's
 * id stands in when it set none) and gains `validator`, the namespaced id
 * `pack:id` (pack-level) or `pack.recipe:id` (recipe-level). A
 * validator that throws becomes an error with rule `validator-error`.
 *
 * Discovery's structural diagnostics are limited to the packs in scope: a
 * sibling pack's broken layout never fails an unrelated pack's run.
 *
 * A requested pack that is not in the registry yields one `pack-not-found`
 * error; callers that need a user-error exit for that check first.
 */
export async function runValidators(
	registry: PackRegistry,
	state: OrchestrationState,
	scope: ValidationScope,
): Promise<ValidationResult> {
	const targetDirectory = registry.root
	const { diagnostics: structural } = registry.discover(false)
	state.status = ENGINE_STATUS.VALIDATING
	const all = registry.all()

	const wanted: string[] | null =
		scope.mode === "recipes"
			? [...new Set(scope.ran.map((r) => r.pack))]
			: scope.pack !== undefined
				? [scope.pack]
				: null
	const targets = wanted ? all.filter((m) => wanted.includes(m.name)) : all

	const diagnostics: ValidationDiagnostic[] = structural.filter(
		(d) => wanted === null || (d.pack !== undefined && wanted.includes(d.pack)),
	)
	for (const name of wanted ?? []) {
		if (all.some((m) => m.name === name)) continue
		diagnostics.push({
			severity: "error",
			rule: "pack-not-found",
			message: `pack "${name}" not found; available packs: ${all.map((m) => m.name).join(", ") || "(none)"}`,
		})
	}

	state.logs.push(`[validate] ${scope.mode} scope over ${targets.length} pack(s)`)

	let projectFiles: string[] | null = null
	const detect = (recipe: PackManifest["recipes"][number]): string[] => {
		if (!recipe.marker || recipe.marker.length === 0) return []
		projectFiles ??= listProjectFiles(targetDirectory)
		return matchGlobs(projectFiles, recipe.marker)
	}

	const attempt = async (validator: string, id: string, call: () => Promise<ValidationDiagnostic[]>): Promise<void> => {
		try {
			for (const d of await call()) {
				diagnostics.push({ ...d, rule: d.rule?.trim() ? d.rule : id, validator })
			}
		} catch (err) {
			diagnostics.push({
				severity: "error",
				rule: "validator-error",
				message: err instanceof Error ? err.message : String(err),
				validator,
			})
		}
	}

	for (const m of targets) {
		// The registry's tracked packRoot, so packs that live outside <root>/packs/ load correctly.
		const packRoot = registry.packRootFor(m.name) ?? `${targetDirectory}/packs/${m.name}`
		const ranHere = scope.mode === "recipes" ? scope.ran.filter((r) => r.pack === m.name) : []
		const lastRan = ranHere.at(-1)
		const packState: OrchestrationState = { ...state, run: lastRan ? toRun(lastRan) : undefined }

		for (const ruleId of m.packValidators) {
			await attempt(`${m.name}:${ruleId}`, ruleId, async () =>
				loadPackValidator(targetDirectory, packRoot, ruleId)(packState),
			)
		}

		const invocations: Array<{ recipe: PackManifest["recipes"][number]; run: ValidatorRun }> = []
		if (scope.mode === "recipes") {
			for (const ran of ranHere) {
				const recipe = m.recipes.find((a) => a.id === ran.recipe)
				if (recipe) invocations.push({ recipe, run: toRun(ran) })
			}
		} else {
			for (const recipe of m.recipes) {
				const detected = detect(recipe)
				if (detected.length > 0) invocations.push({ recipe, run: detectedRun(m.name, recipe.id, detected) })
			}
		}
		for (const { recipe, run } of invocations) {
			const recipeState: OrchestrationState = { ...state, run }
			for (const ruleId of recipe.validators ?? []) {
				await attempt(`${m.name}.${recipe.id}:${ruleId}`, ruleId, async () =>
					loadRecipeValidator(targetDirectory, packRoot, recipe.id, ruleId)(recipeState),
				)
			}
		}
	}

	return { kind: diagnostics.some((d) => d.severity === "error") ? "fail" : "pass", diagnostics }
}

function toRun(ran: RanRecipe): ValidatorRun {
	return {
		pack: ran.pack,
		recipe: ran.recipe,
		ran: true,
		params: ran.params,
		compensationData: ran.compensationData,
		output: ran.output,
		changeset: ran.changeset,
	}
}

function detectedRun(pack: string, recipe: string, detected: string[]): ValidatorRun {
	return { pack, recipe, ran: false, params: {}, compensationData: null, output: null, changeset: [], detected }
}
