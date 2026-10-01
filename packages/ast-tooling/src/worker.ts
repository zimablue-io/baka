import {
	type ActionResult,
	AgentRole,
	BAKA_DEFAULT_WORKER_MODEL,
	type LLMProvider,
	type OrchestrationState,
	type StepContext,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import { ModuleRegistry } from "./registry.js"
import { compensateAction, runAction } from "./run-action.js"
import { createDiskSlotStore } from "./slot-cache.js"

export interface WorkerInput {
	moduleName: string
	actionName: string
	parameters: Record<string, unknown>
}

/**
 * Rollback data returned by the Worker. The SAGA passes this envelope back to
 * the Worker's `compensate`, which undoes the run's files and then invokes the
 * action's own `compensate` with `compensation.actionData`.
 */
export interface WorkerRollbackData {
	moduleName: string
	actionName: string
	targetDirectory: string
	/** The run's receipt: its `compensation` is what an undo needs, the rest is what post-apply validators judge. */
	receipt: ActionResult
}

/**
 * The Worker is the dumb-automations tier. File-producing actions materialize
 * `templates/` to disk; the LLM fills named slots only. `action.ts` runs
 * afterwards for side effects, or is omitted.
 */
export const executeWorkerStep: WorkflowStep<WorkerInput, unknown, WorkerRollbackData> = {
	name: "execute-worker-step",
	role: AgentRole.WORKER,

	execute: async (input, state, ctx): Promise<StepResponse<unknown, WorkerRollbackData>> => {
		const targetDirectory = state.targetDirectory
		if (!targetDirectory) {
			throw new Error("Worker: state.targetDirectory is not set; the SAGA must set it before invoking steps")
		}
		const model = resolveWorkerModel(ctx?.llmProvider ?? null)
		const run = await runAction({
			registry: new ModuleRegistry(targetDirectory, { moduleDirs: state.moduleDirs }),
			store: createDiskSlotStore(targetDirectory, { userFallback: true }),
			module: input.moduleName,
			action: input.actionName,
			params: input.parameters,
			provider: ctx?.llmProvider ?? null,
			model,
			validate: false,
		})
		const compensationData: WorkerRollbackData = {
			moduleName: input.moduleName,
			actionName: input.actionName,
			targetDirectory,
			receipt: run,
		}
		if (!run.ok) {
			const error = run.diagnostics.find((d) => d.severity === "error")
			return { success: false, output: null, compensationData, error: error?.message ?? "action failed" }
		}
		const paths = (ops: string[]) => run.changeset.filter((e) => ops.includes(e.op)).map((e) => e.path)
		return {
			success: true,
			output: run.output ?? { written: paths(["create", "update"]), skipped: paths(["skip"]) },
			compensationData,
		}
	},

	compensate: async (data: WorkerRollbackData, state: OrchestrationState, ctx?: StepContext) => {
		await compensateAction({
			registry: new ModuleRegistry(data.targetDirectory, { moduleDirs: state.moduleDirs }),
			module: data.moduleName,
			action: data.actionName,
			compensation: data.receipt.compensation,
			provider: ctx?.llmProvider ?? null,
		})
	},
}

function resolveWorkerModel(provider: LLMProvider | null): string {
	if (
		provider &&
		"config" in provider &&
		typeof (provider as { config?: { model?: string } }).config?.model === "string"
	) {
		return (provider as { config: { model: string } }).config.model
	}
	return BAKA_DEFAULT_WORKER_MODEL
}
