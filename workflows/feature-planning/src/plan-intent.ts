import { createInitialOrchestrationState, createOrchestratePlanningStep } from "@repo/agent-engine"
import { ModuleRegistry } from "@repo/ast-tooling"
import { ENGINE_STATUS, type LLMProvider, type OrchestrationState } from "@repo/protocol"

export async function featurePlanningWorkflow(
	intent: string,
	rootDir: string,
	provider: LLMProvider,
	moduleDirs?: readonly string[],
): Promise<OrchestrationState> {
	const state: OrchestrationState = {
		...createInitialOrchestrationState(intent, rootDir),
		logs: ["Starting baka orchestration flow."],
	}

	// PLANNING — the Orchestrator LLM picks a sequence of {module, action, params}.
	// Planning never mutates the project tree; execution is handled by `baka apply`.
	// Discovery goes through the engine's single ModuleRegistry so plan sees
	// exactly the modules apply/validate see (tree, project marketplace,
	// user marketplace, bundled).
	const registry = new ModuleRegistry(rootDir, { moduleDirs })
	const { modules } = registry.discover(false)
	state.logs.push(`[plan] discovered ${modules.length} module(s)`)
	if (modules.length === 0) {
		state.status = ENGINE_STATUS.FAILED
		state.logs.push("[plan] no modules were discovered; cannot plan")
		return state
	}

	const orchestratorStep = createOrchestratePlanningStep(provider)
	const planningResult = await orchestratorStep.execute({ intent, availableModules: modules }, state, {
		llmProvider: provider,
	})
	if (!planningResult.success) {
		state.status = ENGINE_STATUS.FAILED
		state.logs.push(`[plan] orchestrator failed: ${planningResult.error}`)
		return state
	}

	const plan = planningResult.output

	// Cross-module action-id collision refusal (architecture decision 12):
	// when two DIFFERENT modules export the same action id, any step that
	// references the ambiguous id would run an indeterminate module's
	// action, so the plan is refused and names every module that exports it.
	const collisions = registry.actionIdCollisions()
	const refusals: string[] = []
	for (const step of plan.resolvedSteps) {
		const offenders = collisions.get(step.action)
		if (offenders) {
			refusals.push(
				`[plan] refused: action id "${step.action}" is exported by multiple modules (${offenders
					.map((m) => `"${m}"`)
					.join(", ")}); remove one of the conflicting modules or rename the action`,
			)
		}
	}
	if (refusals.length > 0) {
		state.status = ENGINE_STATUS.FAILED
		state.logs.push(...refusals)
		state.executionPlan.steps = []
		return state
	}

	state.executionPlan.steps = plan.resolvedSteps
	state.logs.push(`[plan] resolved ${plan.resolvedSteps.length} step(s)`)
	state.status = ENGINE_STATUS.SUCCESS

	return state
}
