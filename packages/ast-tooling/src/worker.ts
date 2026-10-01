import { join } from "node:path"
import {
	AgentRole,
	BAKA_DEFAULT_WORKER_MODEL,
	type LLMProvider,
	type ModuleManifest,
	type OrchestrationState,
	type StepContext,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import { createJiti } from "jiti"
import { loadAction } from "./action-loader.js"
import { ModuleRegistry } from "./registry.js"
import { runNamedAction } from "./run-action.js"

export interface WorkerInput {
	moduleName: string
	actionName: string
	parameters: Record<string, unknown>
}

/**
 * Rollback data returned by the Worker. The SAGA passes this envelope back to
 * the Worker's `compensate`, which invokes the action's own `compensate` with
 * the inner `actionCompensationData`.
 */
export interface WorkerRollbackData {
	moduleName: string
	actionName: string
	parameters: Record<string, unknown>
	targetDirectory: string
	/** Whatever the action's WorkflowStep returned as compensationData. */
	actionCompensationData: unknown
	/** Relative paths materialized from templates this run (deleted on compensate). */
	writtenFiles: string[]
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
		const run = await runNamedAction({
			cwd: targetDirectory,
			module: input.moduleName,
			action: input.actionName,
			params: input.parameters,
			provider: ctx?.llmProvider ?? null,
			model,
			validate: false,
		})
		if (!run.ok) {
			return {
				success: false,
				output: null,
				compensationData: {
					moduleName: input.moduleName,
					actionName: input.actionName,
					parameters: input.parameters,
					targetDirectory,
					actionCompensationData: null,
					writtenFiles: [],
				},
				error: run.error,
			}
		}
		return {
			success: true,
			output: run.output,
			compensationData: {
				moduleName: input.moduleName,
				actionName: input.actionName,
				parameters: input.parameters,
				targetDirectory,
				actionCompensationData: run.compensationData,
				writtenFiles: run.written,
			},
		}
	},

	compensate: async (data: WorkerRollbackData, state: OrchestrationState, ctx?: StepContext) => {
		const { rmSync } = await import("node:fs")
		for (const rel of data.writtenFiles) {
			try {
				rmSync(join(data.targetDirectory, rel), { force: true })
			} catch {
				/* best effort */
			}
		}
		if (data.actionCompensationData == null) return

		const moduleRoot = resolveModuleRoot(data.targetDirectory, data.moduleName)
		if (!moduleRoot) {
			throw new Error(
				`module "${data.moduleName}" not found during rollback (searched tree, project marketplace, user marketplace, and bundled scopes)`,
			)
		}
		const actionTs = join(moduleRoot, data.actionName, "action.ts")
		const { existsSync } = await import("node:fs")
		if (!existsSync(actionTs)) return

		const manifest = loadManifest(moduleRoot, data.moduleName)
		const loaded = loadAction<unknown, unknown, unknown>(data.targetDirectory, moduleRoot, manifest, data.actionName)
		await loaded.step.compensate(data.actionCompensationData, state, ctx)
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

function resolveModuleRoot(targetDirectory: string, moduleName: string): string | null {
	return new ModuleRegistry(targetDirectory).resolveModuleRoot(moduleName) ?? null
}

function loadManifest(moduleRoot: string, moduleName: string): ModuleManifest {
	const manifestPath = join(moduleRoot, "manifest.ts")
	const jiti = createJiti(moduleRoot, { interopDefault: true })
	const mod = jiti(manifestPath) as { Manifest?: ModuleManifest }
	if (!mod.Manifest) throw new Error(`${moduleName}: manifest.ts did not export \`Manifest\``)
	return mod.Manifest
}
