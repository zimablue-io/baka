import {
	type ChangesetEntry,
	ENGINE_STATUS,
	type ModuleManifest,
	type OrchestrationState,
	type ValidationDiagnostic,
	type ValidationResult,
	type ValidatorRun,
} from "@repo/protocol"
import { loadActionValidator, loadModuleValidator } from "./action-loader.js"
import { matchGlobs } from "./glob.js"
import type { ModuleRegistry } from "./registry.js"
import { listProjectFiles } from "./tree-hash.js"

/** One action that ran in this invocation, as validators see it in `state.run`. */
export interface RanAction {
	module: string
	action: string
	/** The params the action ran with (normalized). */
	params: Record<string, unknown>
	/** What the action's `execute` returned as compensation data (template-only actions: `{ written }`). */
	compensationData: unknown
	/** What the action's `execute` returned as output, else null. */
	output: unknown
	changeset: ChangesetEntry[]
}

/**
 * What to validate.
 *
 * - `actions`: the actions that ran in this invocation (a `runAction`, or the
 *   steps of an apply). Each ran action's own validators run with its
 *   `state.run`; the module-level validators of each of those modules run
 *   once, with `state.run` describing the last action of that module that
 *   ran. Nothing else is validated: a module that did not run is not touched.
 * - `project`: `baka validate`. Module-level validators run (for one module,
 *   or all) with no `state.run`; an action's validators run only when the
 *   action declares a `marker` and a file in the project matches it, with
 *   `state.run.ran === false` and `state.run.detected` listing the matches.
 */
export type ValidationScope = { mode: "actions"; ran: readonly RanAction[] } | { mode: "project"; module?: string }

/**
 * Run the validators selected by `scope` and return every diagnostic they
 * (and discovery) produced, warnings included, whichever way the result goes:
 * `kind` is `fail` exactly when some diagnostic is an error.
 *
 * Each validator diagnostic keeps the validator's own `rule` (the validator's
 * id stands in when it set none) and gains `validator`, the namespaced id
 * `module:id` (module-level) or `module.action:id` (action-level). A
 * validator that throws becomes an error with rule `validator-error`.
 *
 * Discovery's structural diagnostics are limited to the modules in scope: a
 * sibling module's broken layout never fails an unrelated module's run.
 *
 * A requested module that is not in the registry yields one `module-not-found`
 * error; callers that need a user-error exit for that check first.
 */
export async function runValidators(
	registry: ModuleRegistry,
	state: OrchestrationState,
	scope: ValidationScope,
): Promise<ValidationResult> {
	const targetDirectory = registry.root
	const { diagnostics: structural } = registry.discover(false)
	state.status = ENGINE_STATUS.VALIDATING
	const all = registry.all()

	const wanted: string[] | null =
		scope.mode === "actions"
			? [...new Set(scope.ran.map((r) => r.module))]
			: scope.module !== undefined
				? [scope.module]
				: null
	const targets = wanted ? all.filter((m) => wanted.includes(m.name)) : all

	const diagnostics: ValidationDiagnostic[] = structural.filter(
		(d) => wanted === null || (d.module !== undefined && wanted.includes(d.module)),
	)
	for (const name of wanted ?? []) {
		if (all.some((m) => m.name === name)) continue
		diagnostics.push({
			severity: "error",
			rule: "module-not-found",
			message: `module "${name}" not found; available modules: ${all.map((m) => m.name).join(", ") || "(none)"}`,
		})
	}

	state.logs.push(`[validate] ${scope.mode} scope over ${targets.length} module(s)`)

	let projectFiles: string[] | null = null
	const detect = (action: ModuleManifest["actions"][number]): string[] => {
		if (!action.marker || action.marker.length === 0) return []
		projectFiles ??= listProjectFiles(targetDirectory)
		return matchGlobs(projectFiles, action.marker)
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
		// The registry's tracked moduleRoot, so modules that live outside <root>/modules/ load correctly.
		const moduleRoot = registry.moduleRootFor(m.name) ?? `${targetDirectory}/modules/${m.name}`
		const ranHere = scope.mode === "actions" ? scope.ran.filter((r) => r.module === m.name) : []
		const lastRan = ranHere.at(-1)
		const moduleState: OrchestrationState = { ...state, run: lastRan ? toRun(lastRan) : undefined }

		for (const ruleId of m.moduleValidators) {
			await attempt(`${m.name}:${ruleId}`, ruleId, async () =>
				loadModuleValidator(targetDirectory, moduleRoot, ruleId)(moduleState),
			)
		}

		const invocations: Array<{ action: ModuleManifest["actions"][number]; run: ValidatorRun }> = []
		if (scope.mode === "actions") {
			for (const ran of ranHere) {
				const action = m.actions.find((a) => a.id === ran.action)
				if (action) invocations.push({ action, run: toRun(ran) })
			}
		} else {
			for (const action of m.actions) {
				const detected = detect(action)
				if (detected.length > 0) invocations.push({ action, run: detectedRun(m.name, action.id, detected) })
			}
		}
		for (const { action, run } of invocations) {
			const actionState: OrchestrationState = { ...state, run }
			for (const ruleId of action.validators ?? []) {
				await attempt(`${m.name}.${action.id}:${ruleId}`, ruleId, async () =>
					loadActionValidator(targetDirectory, moduleRoot, action.id, ruleId)(actionState),
				)
			}
		}
	}

	return { kind: diagnostics.some((d) => d.severity === "error") ? "fail" : "pass", diagnostics }
}

function toRun(ran: RanAction): ValidatorRun {
	return {
		module: ran.module,
		action: ran.action,
		ran: true,
		params: ran.params,
		compensationData: ran.compensationData,
		output: ran.output,
		changeset: ran.changeset,
	}
}

function detectedRun(module: string, action: string, detected: string[]): ValidatorRun {
	return { module, action, ran: false, params: {}, compensationData: null, output: null, changeset: [], detected }
}
