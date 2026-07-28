import { createInitialOrchestrationState, createOrchestratePlanningStep } from "@repo/agent-engine"
import { discoverModules } from "@repo/discovery-workflow"
import { ENGINE_STATUS, type LLMProvider, type OrchestrationState } from "@repo/protocol"

export async function featurePlanningWorkflow(
	intent: string,
	rootDir: string,
	provider: LLMProvider,
): Promise<OrchestrationState> {
	const state: OrchestrationState = {
		...createInitialOrchestrationState(intent, rootDir),
		logs: ["Starting baka orchestration flow."],
	}

	// PLANNING — the Orchestrator LLM picks a sequence of {module, action, params}.
	// Planning never mutates the project tree; execution is handled by `baka apply`.
	const modules = discoverModules(rootDir)
	state.logs.push(`[plan] discovered ${modules.length} module(s)`)
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
	state.executionPlan.steps = plan.resolvedSteps
	state.logs.push(`[plan] resolved ${plan.resolvedSteps.length} step(s)`)
	state.status = ENGINE_STATUS.SUCCESS

	return state
}
