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
 * Compensation shape returned by `executeWorkerStep`. The Worker wraps the
 * action's own compensation data inside this envelope so the SAGA can roll
 * back both the action and the Worker's scratch/output directories.
 */
interface WorkerCompensationEnvelope {
	actionCompensationData?: unknown
}

/**
 * Unwrap a Worker step's compensation data to expose the inner action's
 * compensation data. Validators read this directly (e.g. to inspect
 * `createdFiles`), so they should not have to know about the Worker's
 * envelope shape.
 */
function unwrapWorkerCompensation(raw: unknown): unknown {
	if (raw && typeof raw === "object" && "actionCompensationData" in raw) {
		return (raw as WorkerCompensationEnvelope).actionCompensationData
	}
	return raw
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

		// Normalize the module name by stripping the version suffix the planner
		// emits (e.g. "sdd v0.1.0" → "sdd") since worker steps are keyed by name only.
		const moduleName = planStep.module.split(" v")[0] ?? planStep.module
		const step = stepsByKey.get(`${moduleName}:${planStep.action}`)
		if (!step) {
			const message = `no worker step registered for ${moduleName}:${planStep.action}`
			return fail(state, completed, planStep.id, message, ctx)
		}

		let result: StepResponse<unknown, unknown>
		try {
			result = await step.execute(
				{ moduleName, actionName: planStep.action, parameters: planStep.params },
				state,
				ctx,
			)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			state.logs.push(`[saga] step ${planStep.id} threw: ${message}`)
			return fail(state, completed, planStep.id, message, ctx)
		}

		if (!result.success) {
			const message = result.error ?? "step returned success: false"
			state.logs.push(`[saga] step ${planStep.id} failed: ${message}`)
			return fail(state, completed, planStep.id, message, ctx)
		}

		completed.push({
			id: planStep.id,
			module: moduleName,
			action: planStep.action,
			step,
			compensationData: unwrapWorkerCompensation(result.compensationData),
		})
	}

	state.status = ENGINE_STATUS.SUCCESS
	state.logs.push(`[saga] all ${completed.length} steps completed`)
	return { state, completed, failed: null }
}

async function fail(
	state: OrchestrationState,
	completed: CompletedStep[],
	stepId: string,
	message: string,
	ctx: StepContext,
): Promise<SagaResult> {
	state.logs.push(`[saga] ${message}`)
	await rollback(completed, state, ctx)
	state.status = ENGINE_STATUS.FAILED
	return { state, completed, failed: { id: stepId, error: message } }
}

async function rollback(completed: CompletedStep[], state: OrchestrationState, ctx: StepContext): Promise<void> {
	state.status = ENGINE_STATUS.COMPENSATING
	state.logs.push(`[saga] rolling back ${completed.length} step(s) in reverse`)
	for (let i = completed.length - 1; i >= 0; i--) {
		const c = completed[i]
		if (!c) continue
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
