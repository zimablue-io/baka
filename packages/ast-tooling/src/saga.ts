import {
	ENGINE_STATUS,
	type OrchestrationState,
	type ResolvedPlan,
	type StepContext,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import type { RanRecipe } from "./validator.js"
import type { WorkerRollbackData } from "./worker.js"

export interface SagaStep<TInput = unknown, TOutput = unknown, TCompensationData = unknown> {
	id: string
	pack: string
	recipe: string
	params: TInput
	step: WorkflowStep<TInput, TOutput, TCompensationData>
}

export interface CompletedStep {
	id: string
	pack: string
	recipe: string
	step: WorkflowStep<unknown, unknown, unknown>
	/** Raw compensation data returned by the step. Passed back to the step's `compensate` during rollback. */
	rollbackData: unknown
	/** Unwrapped recipe compensation data exposed to post-apply validators. */
	compensationData: unknown
	/** Rich output payload returned by the step. Surfaced to the MCP per-recipe tool and to the SAGA/apply surfaces so callers can act on real recipe results (e.g. lint's LintReport) instead of a boolean flag. */
	output: unknown
}

/**
 * The completed steps as validators see them (`state.run`): a Worker step's
 * receipt supplies the normalized params, output, compensation data, and
 * changeset; a step from any other source supplies what the saga recorded.
 */
export function ranRecipes(completed: readonly CompletedStep[]): RanRecipe[] {
	return completed.map((c) => {
		const receipt = (c.rollbackData as Partial<WorkerRollbackData> | null | undefined)?.receipt
		return {
			pack: c.pack,
			recipe: c.recipe,
			params: receipt?.params ?? {},
			compensationData: c.compensationData,
			output: c.output,
			changeset: receipt?.changeset ?? [],
		}
	})
}

export interface SagaResult {
	state: OrchestrationState
	completed: CompletedStep[]
	failed: { id: string; error: string } | null
}

/**
 * Compensation shape returned by `executeWorkerStep`. The Worker wraps the
 * recipe's own compensation data inside this envelope so the SAGA can roll
 * back both the recipe and the Worker's scratch/output directories.
 */
interface WorkerCompensationEnvelope {
	compensation?: { recipeData?: unknown }
}

/**
 * Unwrap a Worker step's compensation data to expose the inner recipe's
 * compensation data. Validators read this directly (e.g. to inspect
 * `createdFiles`), so they should not have to know about the Worker's
 * envelope shape.
 */
function unwrapWorkerCompensation(raw: unknown): unknown {
	if (raw && typeof raw === "object" && "compensation" in raw) {
		return (raw as WorkerCompensationEnvelope).compensation?.recipeData
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
		state.logs.push(`[saga] step ${i + 1}/${plan.resolvedSteps.length}: ${planStep.pack}:${planStep.recipe}`)

		// Normalize the pack name by stripping the version suffix the planner
		// emits (e.g. "widget v0.1.0" → "widget") since worker steps are keyed by name only.
		const packName = planStep.pack.split(" v")[0] ?? planStep.pack
		const step = stepsByKey.get(`${packName}:${planStep.recipe}`)
		if (!step) {
			const message = `no worker step registered for ${packName}:${planStep.recipe}`
			return fail(state, completed, planStep.id, message, ctx)
		}

		let result: StepResponse<unknown, unknown>
		try {
			result = await step.execute({ packName, recipeName: planStep.recipe, parameters: planStep.params }, state, ctx)
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
			pack: packName,
			recipe: planStep.recipe,
			step,
			rollbackData: result.compensationData,
			compensationData: unwrapWorkerCompensation(result.compensationData),
			output: result.output,
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
		state.logs.push(`[saga] compensating ${c.pack}:${c.recipe}`)
		try {
			await c.step.compensate(c.rollbackData, state, ctx)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			state.logs.push(`[saga] compensate ${c.pack}:${c.recipe} failed: ${message}`)
			// continue; best-effort
		}
	}
}
