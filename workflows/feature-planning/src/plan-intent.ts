import { createInitialOrchestrationState, createOrchestratePlanningStep } from "@repo/agent-engine"
import { executeWorkerStep, ModuleRegistry, runSaga } from "@repo/ast-tooling"
import { discoverModules } from "@repo/discovery-workflow"
import { ENGINE_STATUS, type LLMProvider, type OrchestrationState, type WorkflowStep } from "@repo/protocol"

export async function featurePlanningWorkflow(
	intent: string,
	rootDir: string,
	provider: LLMProvider,
): Promise<OrchestrationState> {
	const state: OrchestrationState = {
		...createInitialOrchestrationState(intent, rootDir),
		logs: ["Starting baka orchestration flow."],
	}

	// 1. PLANNING — the Orchestrator LLM picks a sequence of {module, action, params}.
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

	// 2. EXECUTING — the SAGA runs the steps with compensation on failure.
	//    For Phase 3 the registry only knows the single Worker step. Phase 5
	//    wires up per-module worker variants. Both share the same SAGA.
	const registry = new ModuleRegistry(rootDir)
	registry.discover(false)
	const stepsByKey = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
	for (const m of registry.all()) {
		for (const a of m.actions) {
			stepsByKey.set(`${m.name}:${a.id}`, executeWorkerStep as unknown as WorkflowStep<unknown, unknown, unknown>)
		}
	}

	const saga = await runSaga(plan, state, { llmProvider: provider }, stepsByKey)
	return saga.state
}
