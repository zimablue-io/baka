import { createInitialOrchestrationState, createOrchestratePlanningStep } from "@repo/agent-engine"
import { PackRegistry } from "@repo/ast-tooling"
import { ENGINE_STATUS, type LLMProvider, type OrchestrationState } from "@repo/protocol"

export async function featurePlanningWorkflow(
	intent: string,
	rootDir: string,
	provider: LLMProvider,
	packDirs?: readonly string[],
): Promise<OrchestrationState> {
	const state: OrchestrationState = {
		...createInitialOrchestrationState(intent, rootDir),
		logs: ["Starting baka orchestration flow."],
	}

	// PLANNING — the Orchestrator LLM picks a sequence of {pack, recipe, params}.
	// Planning never mutates the project tree; execution is handled by `baka apply`.
	// Discovery goes through the engine's single PackRegistry so plan sees
	// exactly the packs apply/validate see (tree, project marketplace,
	// user marketplace, bundled).
	const registry = new PackRegistry(rootDir, { packDirs })
	const { packs } = registry.discover(false)
	state.logs.push(`[plan] discovered ${packs.length} pack(s)`)
	if (packs.length === 0) {
		state.status = ENGINE_STATUS.FAILED
		state.logs.push("[plan] no packs were discovered; cannot plan")
		return state
	}

	const orchestratorStep = createOrchestratePlanningStep(provider)
	const planningResult = await orchestratorStep.execute({ intent, availablePacks: packs }, state, {
		llmProvider: provider,
	})
	if (!planningResult.success) {
		state.status = ENGINE_STATUS.FAILED
		state.logs.push(`[plan] orchestrator failed: ${planningResult.error}`)
		return state
	}

	const plan = planningResult.output

	// Cross-pack recipe-id collision refusal (architecture decision 12):
	// when two DIFFERENT packs export the same recipe id, any step that
	// references the ambiguous id would run an indeterminate pack's
	// recipe, so the plan is refused and names every pack that exports it.
	const collisions = registry.recipeIdCollisions()
	const refusals: string[] = []
	for (const step of plan.resolvedSteps) {
		const offenders = collisions.get(step.recipe)
		if (offenders) {
			refusals.push(
				`[plan] refused: recipe id "${step.recipe}" is exported by multiple packs (${offenders
					.map((m) => `"${m}"`)
					.join(", ")}); remove one of the conflicting packs or rename the recipe`,
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
