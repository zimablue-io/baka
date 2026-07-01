import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	AgentRole,
	type LLMProvider,
	type LLMRequest,
	type ModuleManifest,
	type OrchestrationState,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import Handlebars from "handlebars"
import { createJiti } from "jiti"
import { z } from "zod"
import { loadAction } from "./action-loader.js"

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
 * Rollback data returned by the Worker. The SAGA passes this to the action's
 * `compensate` during rollback, and the Worker's own `compensate` removes
 * the scratch and output directories.
 */
export interface WorkerRollbackData {
	moduleName: string
	actionName: string
	parameters: Record<string, unknown>
	targetDirectory: string
	/** Whatever the action's WorkflowStep returned as compensationData. */
	actionCompensationData: unknown
	/** Scratch dir the action ran in; cleaned up by the Worker's compensate. */
	scratchDir: string
	/** Output dir the scratch was copied into; cleaned up by the Worker's compensate. */
	outputDir: string
}

/**
 * The Worker is the dumb-automations tier. It loads the action the
 * Orchestrator chose, runs it against a fresh scratch dir, copies the result
 * into the real target tree, and returns the data needed to roll back.
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
		const scratchDir = join(tmpdir(), `baka-worker-${input.moduleName}-${input.actionName}-${Date.now()}`)
		const outputDir = join(targetDirectory, "modules", input.moduleName, input.actionName, "out")

		try {
			mkdirSync(scratchDir, { recursive: true })
			const moduleRoot = resolveModuleRoot(targetDirectory, input.moduleName)
			if (!moduleRoot) {
				throw new Error(
					`module "${input.moduleName}" not found (looked in <targetDirectory>/modules/${input.moduleName} and the bundled scope)`,
				)
			}

			const manifest = loadManifest(moduleRoot, input.moduleName)
			const action = manifest.actions.find((a) => a.id === input.actionName)
			if (!action) throw new Error(`action "${input.actionName}" not declared in ${input.moduleName} manifest`)

			const templatesDir = join(moduleRoot, action.id, "templates")
			if (existsSync(templatesDir)) cpSync(templatesDir, join(scratchDir, "templates"), { recursive: true })

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

			if (readdirSync(scratchDir).length > 0) {
				cpSync(scratchDir, outputDir, { recursive: true })
			}

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

	compensate: async (data) => {
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

/**
 * Resolve a module's root directory. Checks the project scope first
 * (`<targetDirectory>/modules/<name>/`), then falls back to the bundled
 * scope. The bundled scope is anchored on `import.meta.url` (the same
 * anchor the `ModuleRegistry.findBundledModulesDir` walk-up uses): the
 * worker and the registry agree on the baka repo's `modules/` dir by
 * walking up from the file URL of the bundled JS. Returns `null` when
 * neither scope has the module.
 *
 */
function resolveModuleRoot(targetDirectory: string, moduleName: string): string | null {
	const projectPath = join(targetDirectory, "modules", moduleName)
	if (existsSync(join(projectPath, "manifest.ts"))) {
		return projectPath
	}
	const bundledDir = findBundledModulesDir()
	if (bundledDir) {
		const bundledPath = join(bundledDir, moduleName)
		if (existsSync(join(bundledPath, "manifest.ts"))) {
			return bundledPath
		}
	}
	return null
}

/**
 * Walk up from `import.meta.url` looking for the baka repo's
 * `modules/baka-base/manifest.ts` marker. Returns the absolute path to
 * `<repo>/modules/` or `null` if the baka repo is not reachable. Mirrors
 * `ModuleRegistry.findBundledModulesDir` so the worker and the registry
 * always agree on the bundled-scope root.
 */
function findBundledModulesDir(): string | null {
	const start = dirname(fileURLToPath(import.meta.url))
	let cur = start
	for (let i = 0; i < 8; i++) {
		const marker = join(cur, "modules", "baka-base", "manifest.ts")
		if (existsSync(marker)) {
			return join(cur, "modules")
		}
		const parent = dirname(cur)
		if (parent === cur) break
		cur = parent
	}
	return null
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
				`Pass --provider or run \`baka providers use <name>\` first.`,
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
