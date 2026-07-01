import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
	AgentRole,
	BAKA_EXIT_CODE,
	BAKA_PROJECT_PATHS,
	BAKA_USER_DIR,
	type LLMMessage,
	type LLMProvider,
	type LLMRequest,
	type ModuleManifest,
	type OrchestrationState,
	type ResolvedLLMConfig,
	type ResolvedPlan,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import { z } from "zod"
import { isRoleName, type RoleName, readRoleConfig } from "./config/store.js"

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface PlanningInput {
	intent: string
	availableModules: ModuleManifest[]
}

export type PlanningOutput = ResolvedPlan

// ---------------------------------------------------------------------------
// Config resolution
//
// Precedence (highest first):
//   1. CLI overrides (the `overrides` arg)
//   2. User config (~/.baka/config.json) — the role's block
//
// The role block in `~/.baka/config.json` is the source of truth. There is
// NO project-tree merge, NO provider alias, NO active marker. apiKey is
// inline in the role block.
//
// Throws `missing LLM config: <role> role not configured` when the role
// block is absent, or `missing LLM config: baseUrl, model` when the block
// is incomplete. Both errors carry `code: BAKA_CONFIG_MISSING`.
// ---------------------------------------------------------------------------

export interface RoleConfigOverrides {
	baseUrl?: string
	apiKey?: string
	model?: string
	temperature?: number
	maxTokens?: number
	timeoutMs?: number
}

export interface LoadConfigOptions {
	role: RoleName
	cwd: string
	overrides?: RoleConfigOverrides
}

/**
 * Resolves the LLM config for one role from `~/.baka/config.json`.
 *
 * Hard-fails when the role block is absent or missing required fields.
 * Callers should treat `role: "worker"` for plan/apply/module-design and
 * `role: "validator"` for any module validator that needs the
 * validator-role LLM.
 */
export async function loadLLMConfig(opts: LoadConfigOptions): Promise<ResolvedLLMConfig> {
	if (!isRoleName(opts.role)) {
		const err = new Error(`missing LLM config: unknown role "${opts.role}". Run \`baka init\` to configure.`)
		;(err as Error & { code?: string }).code = "BAKA_CONFIG_MISSING"
		throw err
	}

	const roleBlock = readRoleConfig(opts.role)
	if (!roleBlock) {
		const err = new Error(`missing LLM config: ${opts.role} role not configured. Run \`baka init\` to configure.`)
		;(err as Error & { code?: string }).code = "BAKA_CONFIG_MISSING"
		throw err
	}

	const overrides = opts.overrides ?? {}
	const baseUrl = overrides.baseUrl ?? roleBlock.baseUrl ?? ""
	const model = overrides.model ?? roleBlock.model ?? ""
	const apiKey = overrides.apiKey ?? roleBlock.apiKey ?? ""
	const temperature = overrides.temperature ?? roleBlock.temperature ?? 0.0
	const maxTokens = overrides.maxTokens ?? roleBlock.maxTokens ?? 8192
	const timeoutMs = overrides.timeoutMs ?? roleBlock.timeoutMs ?? 120_000

	const missing: string[] = []
	if (!baseUrl) missing.push("baseUrl")
	if (!model) missing.push("model")
	if (missing.length > 0) {
		const err = new Error(
			`missing LLM config: ${opts.role} role is missing ${missing.join(", ")}. Run \`baka role ${opts.role}\` to set the field.`,
		)
		;(err as Error & { code?: string }).code = "BAKA_CONFIG_MISSING"
		throw err
	}

	return {
		baseUrl,
		apiKey,
		model,
		temperature,
		maxTokens,
		timeoutMs,
		providerOptions: { role: opts.role },
	}
}

export function validateLLMConfig(config: ResolvedLLMConfig): void {
	const missing: string[] = []
	if (!config.baseUrl) missing.push("baseUrl")
	if (!config.model) missing.push("model")
	if (missing.length > 0) {
		const err = new Error(`missing LLM config: ${missing.join(", ")}. Run \`baka init\` to configure.`)
		;(err as Error & { code?: string }).code = "BAKA_CONFIG_MISSING"
		throw err
	}
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

import { OpenAICompatibleProvider } from "./providers/openai-compatible.js"

export { OpenAICompatibleProvider }

export function createLLMProvider(config: ResolvedLLMConfig): LLMProvider {
	// The wire format is what matters, and right now we only ship the
	// OpenAI-compatible adapter (llama.cpp, Ollama, vLLM, LM Studio, OpenAI,
	// etc. all speak the same /v1/chat shape). If we ever ship a non-OpenAI
	// adapter (Anthropic, Gemini), the dispatch lives here.
	return new OpenAICompatibleProvider(config)
}

// ---------------------------------------------------------------------------
// Config store re-exports (so consumers don't need to dig into ./config/store)
// ---------------------------------------------------------------------------

export type { RoleConfig, RoleName } from "./config/store.js"
export {
	isRoleName,
	listRoles,
	readRoleConfig,
	SUPPORTED_ROLES,
	userConfigPath,
	writeRoleConfig,
} from "./config/store.js"

// ---------------------------------------------------------------------------
// Orchestrator step (factory — provider is injected, never globally resolved)
// ---------------------------------------------------------------------------

const PLANNING_OUTPUT_SCHEMA: z.ZodType<ResolvedPlan> = z.object({
	resolvedSteps: z.array(
		z.object({
			id: z.string(),
			module: z.string(),
			action: z.string(),
			params: z.record(z.any()),
		}),
	),
})

/**
 * Builds the Orchestrator WorkflowStep. The provider is injected; no global
 * state is read. The same factory can be called multiple times with different
 * providers (useful for tests and for switching between named providers).
 */
export function createOrchestratePlanningStep(
	provider: LLMProvider,
): WorkflowStep<PlanningInput, PlanningOutput, null> {
	return {
		name: "orchestrate-planning-step",
		role: AgentRole.ORCHESTRATOR,

		execute: async (input, state): Promise<StepResponse<PlanningOutput, null>> => {
			try {
				const messages: LLMMessage[] = [
					{
						role: "system",
						content:
							"You are the baka Orchestrator. You decompose a user intent into a sequence of steps. " +
							"You may only use modules and actions that appear in the provided module catalog. " +
							"Each step is {id, module, action, params} where params is a flat object whose keys are the exact param names declared in the catalog. " +
							"Param values are JSON primitives (string, number, boolean) or arrays of strings. " +
							'Do not wrap values in extra objects (e.g. {"name": {"value": "x"}} is wrong; {"name": "x"} is right). ' +
							"Respond with a single JSON object matching the schema; do not include any prose, markdown fences, or commentary.",
					},
					{
						role: "user",
						content: buildPlanningPrompt(input.intent, input.availableModules),
					},
				]

				const modelFromState = typeof state.artifacts?.model === "string" ? (state.artifacts.model as string) : ""
				const request: LLMRequest = {
					model: modelFromState,
					messages,
					responseSchema: PLANNING_OUTPUT_SCHEMA,
					temperature: 0.0,
				}

				const response = await provider.chat<ResolvedPlan>(request)
				const normalized = normalizePlan(response.content)
				return {
					success: true,
					output: normalized,
					compensationData: null,
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : "Orchestrator execution failure."
				return {
					success: false,
					output: { resolvedSteps: [] },
					compensationData: null,
					error: message,
				}
			}
		},

		compensate: async (_data, _state): Promise<void> => {
			// The Orchestrator is read-only: it does not mutate the file tree, so
			// there is nothing to compensate. A real WorkflowEngine will still
			// call this on rollback, but the body is a no-op by design.
		},
	}
}

function buildPlanningPrompt(intent: string, modules: ModuleManifest[]): string {
	const catalog = modules
		.map((m) => {
			const actions = m.actions
				.map((a) => {
					const paramList = a.params
						.map((p) => {
							const req = p.required ? " (required)" : ""
							const enumHint = p.enumValues ? ` one of [${p.enumValues.join(", ")}]` : ""
							return `        - ${p.name}: ${p.type}${enumHint}${req} -- ${p.description}`
						})
						.join("\n")
					const paramsBlock = a.params.length > 0 ? `\n      params:\n${paramList}` : "\n      params: (none)"
					return (
						`    - action: ${a.id}` +
						`\n      description: ${a.description}` +
						(a.requiresReasoning ? "\n      requiresReasoning: true" : "") +
						(a.compensatesWith ? `\n      compensatesWith: ${a.compensatesWith}` : "") +
						paramsBlock
					)
				})
				.join("\n")
			return `  module: ${m.name} v${m.version}\n    description: ${m.description || "(no description)"}\n    actions:\n${actions}`
		})
		.join("\n\n")

	const prefs = loadModulePreferences(modules)
	return `Intent: ${intent}\n\nModule catalog (use only these modules and actions):\n\n${catalog || "  (empty - no modules are installed)"}\n\n${prefs}`
}

/**
 * Loads PREFERENCES.md for any module in the catalog that has one, and
 * returns a section to append to the planning prompt. This is what makes
 * the user's design choices sticky across all agent sessions.
 */
function loadModulePreferences(modules: ModuleManifest[]): string {
	const lines: string[] = []
	for (const m of modules) {
		// Try the cwd first (caller is responsible for setting it), then the
		// user marketplace. We can't always know the project root from here
		// (the orchestrator step is provider-agnostic), so we look in the
		// current working directory and the baka user dir.
		const candidates = [
			join(process.cwd(), "modules", m.name, "PREFERENCES.md"),
			join(process.cwd(), BAKA_PROJECT_PATHS.ROOT, "modules", m.name, "PREFERENCES.md"),
			join(homedir(), `.${BAKA_USER_DIR}`, "modules", m.name, "PREFERENCES.md"),
		]
		for (const path of candidates) {
			if (existsSync(path)) {
				const body = readFileSync(path, "utf-8")
				lines.push(`### Module-specific preferences for \`${m.name}\` (from ${path})`)
				lines.push("")
				lines.push(body.trim())
				lines.push("")
				lines.push(
					`When you plan an action from module \`${m.name}\`, you MUST honor these preferences: ` +
						`use the conventions, respect the anti-patterns, and follow the examples. ` +
						`If a plan you produce would violate them, choose a different action or param.`,
				)
				lines.push("")
				break
			}
		}
	}
	if (lines.length === 0) return ""
	return `## Module-specific preferences\n\n${lines.join("\n")}`
}

/**
 * Normalizes a plan returned by a small model that may have wrapped param
 * values in extra objects (e.g. `{"name": {"value": "x"}}` instead of
 * `{"name": "x"}`). We unwrap any object that has a single primitive-valued
 * key, which is the most common form gemma-style models emit when they
 * misread the JSON schema as a key-value pair.
 */
function normalizePlan(plan: ResolvedPlan): ResolvedPlan {
	return {
		resolvedSteps: plan.resolvedSteps.map((step) => ({
			id: step.id,
			module: step.module,
			action: step.action,
			params: normalizeParams(step.params as Record<string, unknown>),
		})),
	}
}

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(params ?? {})) {
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			const entries = Object.entries(v as Record<string, unknown>)
			// Unwrap {"value": <primitive>} or any single-key wrapper.
			if (entries.length === 1) {
				const [, inner] = entries[0] as [string, unknown]
				if (inner === null || typeof inner !== "object") {
					out[k] = inner
					continue
				}
			}
			// Otherwise recurse.
			out[k] = normalizeParams(v as Record<string, unknown>)
		} else {
			out[k] = v
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Engine state factory (used by callers to bootstrap OrchestrationState)
// ---------------------------------------------------------------------------

export function createInitialOrchestrationState(intent: string, targetDirectory: string): OrchestrationState {
	return {
		userIntent: intent,
		targetDirectory,
		status: "PLANNING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
}

export type { DesignTurnInput, DesignTurnOutput, DesignTurnPayload } from "./module-design"

// Re-export the module-design factory and the Zod-typed structured payload.
export {
	createModuleDesignStep,
	DesignTurnPayloadSchema,
	renderActionStubSource,
	renderManifestSource,
	renderPreferencesFile,
	renderTemplateStubSource,
	renderValidatorStubSource,
} from "./module-design"
// Re-export the exit code enum for callers that want to use it
export { BAKA_EXIT_CODE }
