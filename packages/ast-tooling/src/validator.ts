import {
	ENGINE_STATUS,
	type OrchestrationState,
	type ValidationDiagnostic,
	type ValidationResult,
} from "@repo/protocol"
import { ModuleRegistry } from "./registry"
import { loadActionValidator, loadModuleValidator } from "./action-loader"

/**
 * Run all module-level and action-level validators (and the registry's
 * structural checks) against a target directory. Used by `baka validate`
 * and as the post-EXECUTION step in the SAGA. Validators are deterministic
 * TS functions that produce diagnostics; they never block.
 *
 * Action-level validators receive the action's `compensationData` (the
 * data the action's `execute` returned) so they can assert on what the
 * action actually produced.
 */
export async function runValidators(
	targetDirectory: string,
	state: OrchestrationState,
	actionResults?: Map<string, { compensationData: unknown }>,
): Promise<ValidationResult> {
	const registry = new ModuleRegistry(targetDirectory)
	const { diagnostics: structural } = registry.discover(false)
	state.status = ENGINE_STATUS.VALIDATING
	const moduleValidatorCount = registry.all().reduce((n, m) => n + m.moduleValidators.length, 0)
	const actionValidatorCount = registry
		.all()
		.reduce((n, m) => n + m.actions.reduce((a, ac) => a + (ac.validators?.length ?? 0), 0), 0)
	state.logs.push(
		`[validate] running ${moduleValidatorCount} module validator(s) and ${actionValidatorCount} action validator(s)`,
	)

	const allDiagnostics: ValidationDiagnostic[] = [...structural]

	for (const m of registry.all()) {
		const moduleRoot = `${targetDirectory}/modules/${m.name}`
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
