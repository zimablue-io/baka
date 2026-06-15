import { mkdirSync, rmSync, cpSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createJiti } from "jiti"
import {
	AgentRole,
	type LLMProvider,
	type ModuleManifest,
	type OrchestrationState,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import { loadAction } from "./action-loader"

export interface WorkerInput {
	moduleName: string
	actionName: string
	parameters: Record<string, unknown>
}

/**
 * The Worker reads `state.targetDirectory` for the project root. The SAGA
 * sets this on the state before invoking any step, so individual step
 * inputs only need to carry the orchestrator's chosen params.
 */

export interface WorkerRollbackData {
	moduleName: string
	actionName: string
	parameters: Record<string, unknown>
	targetDirectory: string
	// Whatever the action's WorkflowStep returned as compensationData. The SAGA
	// passes this to the action's `compensate` during rollback.
	actionCompensationData: unknown
	// The scratch dir we wrote into. Cleaned up after the action compensate runs.
	scratchDir: string
	// The output dir we copied scratch into, so the Worker's own compensate can
	// remove the produced files even if the action compensate throws.
	outputDir: string
}

/**
 * The Worker is the dumb-automations tier: it loads the action the
 * Orchestrator chose, runs it against a fresh scratch dir, copies the result
 * into the real target tree, and returns the data needed to roll back.
 *
 * If the action advertises `requiresReasoning: true`, the Worker renders the
 * handlebars template into a concrete string by calling the injected
 * LLMProvider; the action itself is still dumb and runs after the LLM has
 * produced the body.
 */
export const executeWorkerStep: WorkflowStep<WorkerInput, boolean, WorkerRollbackData> = {
	name: "execute-worker-step",
	role: AgentRole.WORKER,

	execute: async (input, state, ctx): Promise<StepResponse<boolean, WorkerRollbackData>> => {
		const targetDirectory = state.targetDirectory
		if (!targetDirectory) {
			throw new Error("Worker: state.targetDirectory is not set; the SAGA must set it before invoking steps")
		}
		const scratchDir = join(tmpdir(), `baka-worker-${input.moduleName}-${input.actionName}-${Date.now()}`)
		const outputDir = join(targetDirectory, "modules", input.moduleName, input.actionName, "out")

		try {
			mkdirSync(scratchDir, { recursive: true })
			const moduleRoot = join(targetDirectory, "modules", input.moduleName)
			if (!existsSync(moduleRoot)) {
				throw new Error(`module "${input.moduleName}" not found at ${moduleRoot}`)
			}

			const manifest = loadManifest(targetDirectory, input.moduleName)
			const action = manifest.actions.find((a) => a.id === input.actionName)
			if (!action) throw new Error(`action "${input.actionName}" not declared in ${input.moduleName} manifest`)

			// Make templates and validators available by relative path inside the scratch dir.
			const templatesDir = join(moduleRoot, action.id, "templates")
			if (existsSync(templatesDir)) cpSync(templatesDir, join(scratchDir, "templates"), { recursive: true })

			// If the action requires reasoning, render templates via the LLM.
			const enrichedParams: Record<string, unknown> = action.requiresReasoning
				? await fillReasoningTemplates(input, action, manifest, state, ctx?.llmProvider ?? null)
				: (input.parameters as Record<string, unknown>)

			const loaded = loadAction<Record<string, unknown>, unknown, unknown>(
				targetDirectory,
				moduleRoot,
				manifest,
				action.id,
			)
			const result = await loaded.step.execute(enrichedParams, state, ctx)

			// Overlay the scratch dir into the output location.
			cpSync(scratchDir, outputDir, { recursive: true })

			return {
				success: result.success,
				output: result.success,
				compensationData: {
					moduleName: input.moduleName,
					actionName: input.actionName,
					parameters: input.parameters,
					targetDirectory,
					actionCompensationData: result.compensationData,
					scratchDir,
					outputDir,
				},
				error: result.error,
			}
		} catch (err) {
			return {
				success: false,
				output: false,
				compensationData: {
					moduleName: input.moduleName,
					actionName: input.actionName,
					parameters: input.parameters,
					targetDirectory,
					actionCompensationData: null,
					scratchDir,
					outputDir,
				},
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},

	compensate: async (data, _state): Promise<void> => {
		try {
			if (existsSync(data.outputDir)) rmSync(data.outputDir, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
		try {
			if (existsSync(data.scratchDir)) rmSync(data.scratchDir, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	},
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadManifest(projectRoot: string, moduleName: string): ModuleManifest {
	const manifestPath = join(projectRoot, "modules", moduleName, "manifest.ts")
	const jiti = createJiti(projectRoot, { interopDefault: true })
	const mod = jiti(manifestPath) as { Manifest?: ModuleManifest }
	if (!mod.Manifest) throw new Error(`${moduleName}: manifest.ts did not export \`Manifest\``)
	return mod.Manifest
}

/**
 * For actions with `requiresReasoning: true`, render the handlebars template
 * into a concrete string via the LLM provider. The LLM is only used to fill
 * in the body of the template; the action itself then runs as if the LLM
 * had no creative input.
 *
 * Phase 3 wires the structure; Phase 4 supplies a real LLMProvider. Until
 * then, the call throws so the failure mode is loud.
 */
async function fillReasoningTemplates(
	input: WorkerInput,
	action: { id: string },
	_manifest: ModuleManifest,
	_state: OrchestrationState,
	provider: LLMProvider | null,
): Promise<Record<string, unknown>> {
	void _state
	if (!provider) {
		throw new Error(
			`action "${action.id}" declares requiresReasoning: true, but no LLMProvider was injected into the Worker. ` +
				`Pass --provider or run \`baka providers use <name>\` first.`,
		)
	}
	// Real implementation: walk input.parameters, for each value that is a
	// template path (e.g. params.body === "./templates/<id>.hbs"), render via
	// the LLM and write the rendered body back into the scratch dir under the
	// same relative path. The action then sees a fully-rendered string.
	void input
	throw new Error("requiresReasoning template rendering is wired up in Phase 4")
}
