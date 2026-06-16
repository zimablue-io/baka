import type { z } from "zod"
import type {
	ModuleActionParamSchema,
	ModuleActionSchema,
	ModuleManifestSchema,
	OrchestrationStateSchema,
	ResolvedPlanSchema,
} from "./schemas"

// ---------------------------------------------------------------------------
// Inferred schemas (re-exported as types for ergonomic consumption)
// ---------------------------------------------------------------------------

export type ModuleActionParam = z.infer<typeof ModuleActionParamSchema>
export type ModuleAction = z.infer<typeof ModuleActionSchema>
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>
export type OrchestrationState = z.infer<typeof OrchestrationStateSchema>
export type ResolvedPlan = z.infer<typeof ResolvedPlanSchema>

// ---------------------------------------------------------------------------
// Agent role + workflow step contract
// ---------------------------------------------------------------------------

export enum AgentRole {
	ORCHESTRATOR = "orchestrator",
	WORKER = "worker",
	VALIDATOR = "validator",
}

export interface StepResponse<TOutput, TCompensationData> {
	success: boolean
	output: TOutput
	compensationData: TCompensationData
	error?: string
}

export interface StepContext {
	// The LLM provider the Worker can use to fill handlebars templates for
	// actions that declare `requiresReasoning: true`. May be null in dry-runs
	// and tests; the Worker must throw if it tries to use a null provider.
	llmProvider: LLMProvider | null
}

export interface WorkflowStep<TInput, TOutput, TCompensationData> {
	name: string
	role: AgentRole
	execute: (
		input: TInput,
		state: OrchestrationState,
		ctx?: StepContext,
	) => Promise<StepResponse<TOutput, TCompensationData>>
	compensate: (data: TCompensationData, state: OrchestrationState, ctx?: StepContext) => Promise<void>
}

// ---------------------------------------------------------------------------
// LLM provider abstraction (sealed boundary — implementations live in agent-engine)
// ---------------------------------------------------------------------------

export type LLMMessageRole = "system" | "user" | "assistant" | "tool"

export interface LLMMessage {
	role: LLMMessageRole
	content: string
	name?: string
}

export interface LLMRequest {
	model: string
	messages: LLMMessage[]
	// Zod schema the response must conform to. The provider is responsible for
	// either constraining the model (e.g. response_format: json_schema) or
	// validating the output post-hoc. Implementations MUST reject responses
	// that do not parse against this schema.
	responseSchema: z.ZodType<unknown>
	temperature?: number
	maxTokens?: number
	timeoutMs?: number
	// Provider-specific extensions. Use sparingly; the goal is for all providers
	// to handle the common fields above and nothing else.
	providerOptions?: Record<string, unknown>
}

export interface LLMUsage {
	promptTokens: number
	completionTokens: number
}

export interface LLMResponse<T = unknown> {
	content: T
	usage: LLMUsage
	// Provider-native payload, kept for logging and debugging only.
	raw: unknown
}

export interface LLMProvider {
	readonly name: string
	chat<T = unknown>(request: LLMRequest): Promise<LLMResponse<T>>
	validateConfig(): void
}

// ---------------------------------------------------------------------------
// Resolved LLM config (output of agent-engine's config loader)
// ---------------------------------------------------------------------------

export interface ResolvedLLMConfig {
	baseUrl: string
	apiKey: string
	model: string
	temperature: number
	maxTokens: number
	timeoutMs: number
	// Free-form provider-specific options. Concrete providers (e.g. openai-compatible)
	// read only the keys they understand; everything else is ignored.
	providerOptions: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidationDiagnostic = {
	severity: "error" | "warning"
	rule: string
	message: string
	file?: string
	hint?: string
}

export type ValidationResult = { kind: "pass" } | { kind: "fail"; diagnostics: ValidationDiagnostic[] }
