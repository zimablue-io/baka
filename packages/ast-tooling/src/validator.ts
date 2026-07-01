import {
	ENGINE_STATUS,
	type OrchestrationState,
	type ValidationDiagnostic,
	type ValidationResult,
} from "@repo/protocol"
import { loadActionValidator, loadModuleValidator } from "./action-loader.js"
import { ModuleRegistry } from "./registry.js"

/**
 * Run all module-level and action-level validators (and the registry's
 * structural checks) against a target directory. Used by `baka validate`
 * and as the post-EXECUTION step in the SAGA. Validators are deterministic
 * TS functions that produce diagnostics; they never block.
 *
 * Action-level validators receive the action's `compensationData` (the
 * data the action's `execute` returned) so they can assert on what the
 * action actually produced.
 *
 * If `moduleName` is provided, only that module's validators run. The
 * caller is responsible for the "module not found" user error (which
 * must exit `BAKA_EXIT_CODE.USER_ERROR = 1`, not the validation-error
 * exit code this function produces). When `moduleName` is provided and
 * no module matches, this function emits a single
 * `module-not-found` diagnostic so the validation result is `fail` and
 * downstream consumers see the same shape regardless of the filter
 * outcome.
 *
 * If `moduleFilter` is provided, only modules whose name is in the
 * list run. This is the apply-path filter: the apply should only
 * validate modules whose actions actually ran, not every discovered
 * module. Running every discovered module on a large monorepo
 * (where bundled modules like `ts-style` scan the whole
 * tree) turns a 0.1s validate into a 3-minute apply, and surfaces
 * violations from modules the user did not invoke (e.g. `ts-style`
 * finding `: any`. `moduleFilter` takes precedence over `moduleName` when
 * both are provided.
 */
export async function runValidators(
	targetDirectory: string,
	state: OrchestrationState,
	actionResults?: Map<string, { compensationData: unknown }>,
	moduleName?: string,
	moduleFilter?: string[],
): Promise<ValidationResult> {
	const registry = new ModuleRegistry(targetDirectory)
	const { diagnostics: structural } = registry.discover(false)
	state.status = ENGINE_STATUS.VALIDATING
	const allDiscovered = registry.all()
	const targetModules = moduleFilter
		? allDiscovered.filter((m) => moduleFilter.includes(m.name))
		: moduleName
			? allDiscovered.filter((m) => m.name === moduleName)
			: allDiscovered
	const moduleValidatorCount = targetModules.reduce((n, m) => n + m.moduleValidators.length, 0)
	const actionValidatorCount = targetModules.reduce(
		(n, m) => n + m.actions.reduce((a, ac) => a + (ac.validators?.length ?? 0), 0),
		0,
	)
	state.logs.push(
		`[validate] running ${moduleValidatorCount} module validator(s) and ${actionValidatorCount} action validator(s)`,
	)

	const allDiagnostics: ValidationDiagnostic[] = [...structural]

	if ((moduleName || moduleFilter) && targetModules.length === 0) {
		allDiagnostics.push({
			severity: "error",
			rule: "module-not-found",
			message: `module "${moduleName ?? moduleFilter?.join(",")}" not found; available modules: ${
				registry
					.all()
					.map((m) => m.name)
					.join(", ") || "(none)"
			}`,
		})
	}

	for (const m of targetModules) {
		// Use the registry's tracked moduleRoot so bundled modules (which
		// live outside of <targetDirectory>/modules/) load correctly.
		// Falls back to <targetDirectory>/modules/<name> for any caller
		// that hasn't run discover() (defensive only; the registry path
		// is the normal flow).
		const moduleRoot = registry.moduleRootFor(m.name) ?? `${targetDirectory}/modules/${m.name}`
		for (const ruleId of m.moduleValidators) {
			try {
				const fn = loadModuleValidator(targetDirectory, moduleRoot, ruleId)
				const out = await fn(state)
				for (const d of out) {
					allDiagnostics.push({ ...d, rule: `${m.name}:${ruleId}` })
				}
			} catch (err) {
				allDiagnostics.push({
					severity: "error",
					rule: `${m.name}:${ruleId}`,
					message: err instanceof Error ? err.message : String(err),
				})
			}
		}
		for (const action of m.actions) {
			for (const ruleId of action.validators ?? []) {
				try {
					const fn = loadActionValidator(targetDirectory, moduleRoot, action.id, ruleId)
					const key = `${m.name}:${action.id}`
					const data = actionResults?.get(key)?.compensationData
					const out = await fn(state, data)
					for (const d of out) {
						allDiagnostics.push({ ...d, rule: `${m.name}.${action.id}:${ruleId}` })
					}
				} catch (err) {
					allDiagnostics.push({
						severity: "error",
						rule: `${m.name}.${action.id}:${ruleId}`,
						message: err instanceof Error ? err.message : String(err),
					})
				}
			}
		}
	}

	if (allDiagnostics.some((d) => d.severity === "error")) {
		return { kind: "fail", diagnostics: allDiagnostics }
	}
	return { kind: "pass" }
}
