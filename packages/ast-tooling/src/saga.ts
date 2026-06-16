import {
	ENGINE_STATUS,
	type OrchestrationState,
	type ResolvedPlan,
	type StepContext,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"

export interface SagaStep<TInput = unknown, TOutput = unknown, TCompensationData = unknown> {
	id: string
	module: string
	action: string
	params: TInput
	step: WorkflowStep<TInput, TOutput, TCompensationData>
}

export interface CompletedStep {
	id: string
	module: string
	action: string
	step: WorkflowStep<unknown, unknown, unknown>
	compensationData: unknown
}

export interface SagaResult {
	state: OrchestrationState
	completed: CompletedStep[]
	failed: { id: string; error: string } | null
}

/**
 * The SAGA orchestrator. Runs the plan step by step, tracks completed steps,
 * and on failure rolls them back in reverse order. The rollback call always
 * runs (it is wrapped in a try/catch) so that one bad compensate does not
 * strand the system.
 *
 * Compensations are best-effort: errors are logged to state.logs and the
 * SAGA continues. The final state will be FAILED with the original error
 * preserved, plus per-compensate errors appended.
 */
export async function runSaga(
	plan: ResolvedPlan,
	state: OrchestrationState,
	ctx: StepContext,
	stepsByKey: Map<string, WorkflowStep<unknown, unknown, unknown>>,
): Promise<SagaResult> {
	const completed: CompletedStep[] = []
	state.status = ENGINE_STATUS.EXECUTING

	for (let i = 0; i < plan.resolvedSteps.length; i++) {
		const planStep = plan.resolvedSteps[i]
		state.executionPlan.currentStepIndex = i
		state.logs.push(`[saga] step ${i + 1}/${plan.resolvedSteps.length}: ${planStep.module}:${planStep.action}`)

		const key = `${planStep.module}:${planStep.action}`
		const step = stepsByKey.get(key)
		if (!step) {
			const err = `no worker step registered for ${key}`
			state.logs.push(`[saga] ${err}`)
			const failed = { id: planStep.id, error: err }
			await rollback(completed, state, ctx)
			state.status = ENGINE_STATUS.FAILED
			return { state, completed, failed }
		}

		let result: StepResponse<unknown, unknown>
		try {
			// Wrap the step's input so it carries the module/action names from
			// the plan step plus the orchestrator's chosen params as `parameters`.
			// Worker steps are keyed by `module:action` in the registry; this
			// wrap lets the same step type handle every action in a plan.
			const wrappedInput = {
				moduleName: planStep.module,
				actionName: planStep.action,
				parameters: planStep.params,
			}
			result = await step.execute(wrappedInput, state, ctx)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			state.logs.push(`[saga] step ${planStep.id} threw: ${message}`)
			const failed = { id: planStep.id, error: message }
			await rollback(completed, state, ctx)
			state.status = ENGINE_STATUS.FAILED
			return { state, completed, failed }
		}

		if (!result.success) {
			const message = result.error ?? "step returned success: false"
			state.logs.push(`[saga] step ${planStep.id} failed: ${message}`)
			const failed = { id: planStep.id, error: message }
			await rollback(completed, state, ctx)
			state.status = ENGINE_STATUS.FAILED
			return { state, completed, failed }
		}

		completed.push({
			id: planStep.id,
			module: planStep.module,
			action: planStep.action,
			step,
			compensationData: result.compensationData,
		})
	}

	state.status = ENGINE_STATUS.SUCCESS
	state.logs.push(`[saga] all ${completed.length} steps completed`)
	return { state, completed, failed: null }
}

async function rollback(completed: CompletedStep[], state: OrchestrationState, ctx: StepContext): Promise<void> {
	state.status = ENGINE_STATUS.COMPENSATING
	state.logs.push(`[saga] rolling back ${completed.length} step(s) in reverse`)
	for (let i = completed.length - 1; i >= 0; i--) {
		const c = completed[i]
		state.logs.push(`[saga] compensating ${c.module}:${c.action}`)
		try {
			await c.step.compensate(c.compensationData, state, ctx)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			state.logs.push(`[saga] compensate ${c.module}:${c.action} failed: ${message}`)
			// continue; best-effort
		}
	}
}
