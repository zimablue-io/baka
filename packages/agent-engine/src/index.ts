import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import {
	AgentRole,
	BAKA_ENV_PREFIX,
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
import { getActiveProviderName, getApiKey, getProvider } from "./config/store.js"

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
//   1. CLI overrides (passed as the `overrides` arg)
//   2. Per-project local override (cwd/.baka/local.json)  -- future
//   3. BAKA_LLM_* env vars
//   4. User config + credentials (XDG)
//   5. Built-in defaults
//
// Throws BAKA_CONFIG_MISSING if the resolved config is incomplete (no baseUrl
// or no model) and there is no obvious default to fall back to.
// ---------------------------------------------------------------------------

interface PartialConfig {
	baseUrl?: string
	apiKey?: string
	model?: string
	temperature?: number
	maxTokens?: number
	timeoutMs?: number
	providerOptions?: Record<string, unknown>
}

function readEnv(overrides: PartialConfig): PartialConfig {
	const env = process.env
	return {
		baseUrl: overrides.baseUrl ?? env[`${BAKA_ENV_PREFIX}LLM_BASE_URL`] ?? undefined,
		apiKey: overrides.apiKey ?? env[`${BAKA_ENV_PREFIX}LLM_API_KEY`] ?? undefined,
		model: overrides.model ?? env[`${BAKA_ENV_PREFIX}LLM_MODEL`] ?? undefined,
		temperature:
			overrides.temperature ??
			(env[`${BAKA_ENV_PREFIX}LLM_TEMPERATURE`] ? Number(env[`${BAKA_ENV_PREFIX}LLM_TEMPERATURE`]) : undefined),
		maxTokens:
			overrides.maxTokens ??
			(env[`${BAKA_ENV_PREFIX}LLM_MAX_TOKENS`] ? Number(env[`${BAKA_ENV_PREFIX}LLM_MAX_TOKENS`]) : undefined),
		timeoutMs:
			overrides.timeoutMs ??
			(env[`${BAKA_ENV_PREFIX}LLM_TIMEOUT_MS`] ? Number(env[`${BAKA_ENV_PREFIX}LLM_TIMEOUT_MS`]) : undefined),
	}
}

function readUserConfig(overrides: PartialConfig, explicitName?: string): PartialConfig {
	const activeName = explicitName ?? getActiveProviderName()
	if (!activeName) return {}
	const provider = getProvider(activeName)
	if (!provider) return {}
	return {
		baseUrl: overrides.baseUrl ?? provider.baseUrl,
		apiKey: overrides.apiKey, // API key lives in credentials, resolved separately
		model: overrides.model ?? provider.model,
		temperature: overrides.temperature ?? provider.temperature,
		maxTokens: overrides.maxTokens ?? provider.maxTokens,
		timeoutMs: overrides.timeoutMs ?? provider.timeoutMs,
		providerOptions: overrides.providerOptions ?? provider.providerOptions,
	}
}

function readProjectLocal(cwd: string, overrides: PartialConfig): PartialConfig {
	const path = join(cwd, BAKA_PROJECT_PATHS.LOCAL_CONFIG)
	if (!existsSync(path)) return {}
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as PartialConfig
		return {
			baseUrl: overrides.baseUrl ?? raw.baseUrl,
			apiKey: overrides.apiKey ?? raw.apiKey,
			model: overrides.model ?? raw.model,
			temperature: overrides.temperature ?? raw.temperature,
			maxTokens: overrides.maxTokens ?? raw.maxTokens,
			timeoutMs: overrides.timeoutMs ?? raw.timeoutMs,
		}
	} catch {
		return {}
	}
}

export interface LoadConfigOptions {
	cwd: string
	overrides?: PartialConfig
	providerName?: string
	skipCredentials?: boolean
}

/**
 * Resolves the LLM config from all sources. If `providerName` is not given,
 * uses the user's active provider. API keys are looked up from the credentials
 * file unless `skipCredentials` is true.
 */
export async function loadLLMConfig(opts: LoadConfigOptions): Promise<ResolvedLLMConfig> {
	const overrides = opts.overrides ?? {}
	const envPart = readEnv(overrides)
	const projectPart = readProjectLocal(opts.cwd, overrides)
	const userPart = readUserConfig(overrides, opts.providerName)
	const merged: PartialConfig = { ...userPart, ...projectPart, ...envPart }

	// API key resolution: from credentials file (for the active/named provider),
	// unless the user already provided one via overrides/env/project-local.
	let apiKey = merged.apiKey
	if (!apiKey && !opts.skipCredentials) {
		const name = opts.providerName ?? getActiveProviderName()
		if (name) apiKey = await getApiKey(name)
	}
	if (apiKey === undefined) apiKey = ""

	const temperature = merged.temperature ?? 0.0
	const maxTokens = merged.maxTokens ?? 8192
	const timeoutMs = merged.timeoutMs ?? 120_000

	return {
		baseUrl: merged.baseUrl ?? "",
		apiKey,
		model: merged.model ?? "",
		temperature,
		maxTokens,
		timeoutMs,
		providerOptions: {
			...(merged.providerOptions ?? {}),
			// Carry the provider name through so createLLMProvider can dispatch.
			name: opts.providerName ?? getActiveProviderName() ?? "openai-compatible",
		},
	}
}

export function validateLLMConfig(config: ResolvedLLMConfig): void {
	const missing: string[] = []
	if (!config.baseUrl) missing.push("baseUrl (BAKA_LLM_BASE_URL)")
	if (!config.model) missing.push("model (BAKA_LLM_MODEL)")
	if (missing.length > 0) {
		const err = new Error(`missing LLM config: ${missing.join(", ")}. Run \`baka init\` to configure.`)
		;(err as Error & { code?: string }).code = "BAKA_CONFIG_MISSING"
		throw err
	}
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

import { OpenAICompatibleProvider } from "./openai-compatible.js"

export { OpenAICompatibleProvider }

export function createLLMProvider(config: ResolvedLLMConfig): LLMProvider {
	// The user-configured provider name lives in config.providerOptions.name,
	// set by `loadLLMConfig`. We currently ship only the openai-compatible
	// adapter; additional adapters register themselves via createLLMProvider
	// dispatch in later phases.
	const providerName = (config.providerOptions?.name as string | undefined) ?? "openai-compatible"
	switch (providerName) {
		case "openai-compatible":
			return new OpenAICompatibleProvider(config)
		default:
			throw new Error(
				`baka: unknown provider "${providerName}". Run \`baka providers list\` to see installed providers, or \`baka providers add\` to register one.`,
			)
	}
}

// ---------------------------------------------------------------------------
// Config store re-exports (so consumers don't need to dig into ./config/store)
// ---------------------------------------------------------------------------

export {
	deleteProvider,
	getActiveProviderName,
	getApiKey,
	getConfigPath,
	getConfigValue,
	getProvider,
	listConfigKeys,
	listProviders,
	secretsPath,
	setActiveProviderName,
	setApiKey,
	setConfigValue,
	setProvider,
	unsetApiKey,
	unsetConfigValue,
	userConfigPath,
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
							"Do not wrap values in extra objects (e.g. {\"name\": {\"value\": \"x\"}} is wrong; {\"name\": \"x\"} is right). " +
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
			join(homedir(), ".local", "share", BAKA_USER_DIR, "modules", m.name, "PREFERENCES.md"),
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
	return "## Module-specific preferences\n\n" + lines.join("\n")
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

// Re-export the exit code enum for callers that want to use it
export { BAKA_EXIT_CODE }

// Re-export the module-design factory and the Zod-typed structured payload.
export {
	createModuleDesignStep,
	renderActionStubSource,
	renderManifestSource,
	renderPreferencesFile,
	renderTemplateStubSource,
	renderValidatorStubSource,
	DesignTurnPayloadSchema,
} from "./module-design"
export type { DesignTurnInput, DesignTurnOutput, DesignTurnPayload } from "./module-design"
