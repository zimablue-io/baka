import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	AgentRole,
	type LLMProvider,
	type LLMRequest,
	type ModuleManifest,
	type OrchestrationState,
	type StepContext,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import Handlebars from "handlebars"
import { createJiti } from "jiti"
import { z } from "zod"
import { loadAction } from "./action-loader.js"
import { ModuleRegistry } from "./registry.js"

/**
 * Handlebars comment sentinel that opts a template out of LLM reasoning. If a
 * .hbs file contains `{{!-- no-llm --}}` anywhere, the worker writes the
 * pre-rendered template content directly to disk without calling the LLM.
 */
const NO_LLM_SENTINEL = /\{\{!--\s*no-llm\s*--\}\}/

/**
 * Shape of the LLM response for a single template render. The schema is
 * enforced by the provider via constrained decoding when available, and
 * validated post-hoc by the provider as a fallback.
 */
const TEMPLATE_RESPONSE_SCHEMA = z.object({ content: z.string() })

/**
 * System prompt used when asking the LLM to fill in the body of a template.
 * The user prompt is the handlebars-pre-rendered template content.
 */
const TEMPLATE_SYSTEM_PROMPT =
	"You are an LLM assistant for the baka engine. The user prompt is a template " +
	"that was pre-filled with known params. Generate the requested content. " +
	"Respond with valid JSON matching the schema."

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
}

/**
 * The Worker is the dumb-automations tier. It loads the action the
 * Orchestrator chose, runs it with the resolved parameters, and lets the
 * action write directly to the target tree. It returns the data needed to
 * roll back.
 *
 * If the action advertises `requiresReasoning: true`, the Worker renders
 * handlebars templates (under `<module>/<action>/templates/`) into LLM
 * prompts, calls the injected LLMProvider to fill the body, and passes the
 * generated content to the action as `renderedTemplates`.
 */
export const executeWorkerStep: WorkflowStep<WorkerInput, boolean, WorkerRollbackData> = {
	name: "execute-worker-step",
	role: AgentRole.WORKER,

	execute: async (input, state, ctx): Promise<StepResponse<boolean, WorkerRollbackData>> => {
		const targetDirectory = state.targetDirectory
		if (!targetDirectory) {
			throw new Error("Worker: state.targetDirectory is not set; the SAGA must set it before invoking steps")
		}
		try {
			const moduleRoot = resolveModuleRoot(targetDirectory, input.moduleName)
			if (!moduleRoot) {
				throw new Error(
					`module "${input.moduleName}" not found (searched tree, project marketplace, user marketplace, and bundled scopes)`,
				)
			}

			const manifest = loadManifest(moduleRoot, input.moduleName)
			const action = manifest.actions.find((a) => a.id === input.actionName)
			if (!action) throw new Error(`action "${input.actionName}" not declared in ${input.moduleName} manifest`)

			const enrichedParams: Record<string, unknown> = action.requiresReasoning
				? await fillReasoningTemplates(input, action, state, ctx?.llmProvider ?? null, moduleRoot)
				: input.parameters

			const loaded = loadAction<Record<string, unknown>, unknown, unknown>(
				targetDirectory,
				moduleRoot,
				manifest,
				action.id,
			)
			const result = await loaded.step.execute(enrichedParams, state, ctx)

			return {
				success: result.success,
				output: result.success,
				compensationData: {
					moduleName: input.moduleName,
					actionName: input.actionName,
					parameters: input.parameters,
					targetDirectory,
					actionCompensationData: result.compensationData,
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
				},
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},

	compensate: async (data: WorkerRollbackData, state: OrchestrationState, ctx?: StepContext) => {
		// Invoke the action's own compensate through the production loader. The SAGA
		// already wraps rollback in best-effort error handling, so failures here
		// propagate and are logged without blocking subsequent compensations.
		if (data.actionCompensationData == null) return

		const moduleRoot = resolveModuleRoot(data.targetDirectory, data.moduleName)
		if (!moduleRoot) {
			throw new Error(
				`module "${data.moduleName}" not found during rollback (searched tree, project marketplace, user marketplace, and bundled scopes)`,
			)
		}
		const manifest = loadManifest(moduleRoot, data.moduleName)
		const loaded = loadAction<unknown, unknown, unknown>(data.targetDirectory, moduleRoot, manifest, data.actionName)
		await loaded.step.compensate(data.actionCompensationData, state, ctx)
	},
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a module's root directory through the ModuleRegistry so the
 * worker sees exactly the scopes the engine's discovery sees (tree,
 * project marketplace, user marketplace, bundled) with the same
 * precedence. Returns `null` when no scope has the module.
 */
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

/**
 * For actions with `requiresReasoning: true`, discover handlebars templates
 * under `<module>/<action>/templates/`, pre-render each with the action
 * params, then call the LLM to generate the body content. The LLM responses
 * are collected into `renderedTemplates` keyed by the template path without
 * `.hbs` (relative to the templates dir).
 *
 * If no `templates/` dir exists, or no `.hbs` files are present, the
 * parameters pass through unchanged with an empty `renderedTemplates`.
 */
async function fillReasoningTemplates(
	input: WorkerInput,
	action: { id: string },
	_state: OrchestrationState,
	provider: LLMProvider | null,
	moduleRoot: string,
): Promise<Record<string, unknown>> {
	// `moduleRoot` is now the source of truth for the templates dir (it may
	// live in the bundled scope, not under `<targetDirectory>/modules/`).
	// The SAGA still requires `state.targetDirectory` to be set; the
	// `state` parameter is kept for that invariant, but we no longer
	// derive the templates path from it.
	if (!provider) {
		throw new Error(
			`action "${action.id}" declares requiresReasoning: true, but no LLMProvider was injected into the Worker. ` +
				`Run \`baka init\` to configure the worker role.`,
		)
	}

	const templatesDir = join(moduleRoot, action.id, "templates")
	if (!existsSync(templatesDir)) {
		return { ...input.parameters, renderedTemplates: {} }
	}

	const hbsFiles = discoverHbsFiles(templatesDir)
	if (hbsFiles.length === 0) {
		return { ...input.parameters, renderedTemplates: {} }
	}

	const renderedTemplates: Record<string, string> = {}
	for (const hbsFile of hbsFiles) {
		const content = readFileSync(hbsFile, "utf-8")
		const key = relativePath(templatesDir, hbsFile).replace(/\.hbs$/, "")
		const preRendered = Handlebars.compile(content)(input.parameters)

		renderedTemplates[key] = NO_LLM_SENTINEL.test(content) ? preRendered : await callLLM(provider, preRendered)
	}

	return { ...input.parameters, renderedTemplates }
}

/**
 * Call the LLM to fill in the body of a pre-rendered handlebars template.
 * The template's text becomes the user prompt; the response schema constrains
 * the model to return `{ content: string }`.
 */
async function callLLM(provider: LLMProvider, preRendered: string): Promise<string> {
	const request: LLMRequest = {
		model: "",
		messages: [
			{ role: "system", content: TEMPLATE_SYSTEM_PROMPT },
			{ role: "user", content: preRendered },
		],
		responseSchema: TEMPLATE_RESPONSE_SCHEMA,
		temperature: 0.7,
	}
	const response = await provider.chat<{ content: string }>(request)
	return response.content.content.trim()
}

/** Recursively discover all `.hbs` files under a directory. */
function discoverHbsFiles(dir: string): string[] {
	if (!existsSync(dir)) return []

	const results: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			results.push(...discoverHbsFiles(fullPath))
		} else if (entry.isFile() && entry.name.endsWith(".hbs")) {
			results.push(fullPath)
		}
	}
	return results
}

/** Compute the relative path of `target` from `base`, using forward slashes. */
function relativePath(base: string, target: string): string {
	return target.slice(base.length).split(/\/|\\/).filter(Boolean).join("/")
}
