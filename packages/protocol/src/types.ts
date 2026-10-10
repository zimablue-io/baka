import type { z } from "zod"
import type { RECIPE_ERROR_CODES } from "./constants"
import type {
	ApiErrorSchema,
	BakaLockSchema,
	ChangeOpSchema,
	ChangesetEntrySchema,
	LlmCallSchema,
	OnExistingSchema,
	OpenSlotSchema,
	OrchestrationStateSchema,
	PackManifestSchema,
	PackPinSchema,
	PackRecipeParam,
	PackRecipeSchema,
	ParamFormat,
	ParamTypeNode,
	RecipeCompensationSchema,
	RecipeResultSchema,
	ResolvedPlanSchema,
	SlotDeclSchema,
	SlotModeSchema,
	SlotRecordSchema,
	SlotsInputSchema,
	ValidatorRunSchema,
} from "./schemas"

// ---------------------------------------------------------------------------
// Inferred schemas (re-exported as types for ergonomic consumption)
// ---------------------------------------------------------------------------

export type PackRecipe = z.infer<typeof PackRecipeSchema>
export type PackManifest = z.infer<typeof PackManifestSchema>
export type OrchestrationState = z.infer<typeof OrchestrationStateSchema>
export type ResolvedPlan = z.infer<typeof ResolvedPlanSchema>
export type SlotDecl = z.infer<typeof SlotDeclSchema>
export type OpenSlot = z.infer<typeof OpenSlotSchema>
export type { PackRecipeParam, ParamFormat, ParamTypeNode }
export type RecipeErrorCode = (typeof RECIPE_ERROR_CODES)[number]
export type ChangeOp = z.infer<typeof ChangeOpSchema>
export type ChangesetEntry = z.infer<typeof ChangesetEntrySchema>
export type SlotRecord = z.infer<typeof SlotRecordSchema>
export type OnExisting = z.infer<typeof OnExistingSchema>
export type PackPin = z.infer<typeof PackPinSchema>
export type BakaLock = z.infer<typeof BakaLockSchema>
export type SlotMode = z.infer<typeof SlotModeSchema>
export type SlotsInput = z.infer<typeof SlotsInputSchema>
export type RecipeCompensation = z.infer<typeof RecipeCompensationSchema>
export type RecipeResult = z.infer<typeof RecipeResultSchema>
export type ValidatorRun = z.infer<typeof ValidatorRunSchema>

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
	// recipes that declare `requiresReasoning: true`. May be null in dry-runs
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
// The `recipe.ts` contract
// ---------------------------------------------------------------------------

/** How a write through `RecipeFiles` ended. `skip` and `unchanged` wrote nothing. */
export interface RecipeFileWrite {
	/** The normalized project-relative path. */
	path: string
	op: "create" | "update" | "unchanged" | "skip"
	/** sha256 (lowercase hex) of the file's bytes after the call. */
	contentHash: string
}

export interface RecipeWriteOptions {
	/** Overrides the run's `onExisting` for this one file. */
	onExisting?: OnExisting
	/**
	 * Permission bits as three or four octal digits (`"0755"`; no setuid,
	 * setgid, or sticky bit). Part of the file's identity: identical bytes
	 * with other bits are not `unchanged`, they are handled by `onExisting`.
	 */
	mode?: string
}

/**
 * The file API Baka hands to a `recipe.ts`. Every path is project-relative
 * and POSIX (`packages/ui/package.json`) and is checked for containment
 * (see docs/PACKS.md, "Path containment"): an absolute path, a `..`
 * segment, a path through `.git` or the root's `.baka/`, or one that
 * resolves outside the root through a symlink throws and writes nothing.
 *
 * Writes made here honour `onExisting`, are reported in the receipt's
 * changeset (including as `unchanged` when the bytes are already there, so a
 * rerun hashes the same), and are undone by the engine if the run fails. In
 * a dry run they go to a virtual tree: reads see them, the disk does not.
 */
export interface RecipeFiles {
	exists(path: string): boolean
	/** The file's text (UTF-8). Throws if it does not exist. */
	readText(path: string): string
	/**
	 * Write `content`, creating parent directories. An existing file is
	 * handled by `onExisting`: `skip` leaves other bytes alone (`op: "skip"`),
	 * `overwrite` rewrites them (`update`), `fail` throws `target-exists`.
	 * Identical bytes are always `unchanged`.
	 */
	write(path: string, content: string | Uint8Array, options?: RecipeWriteOptions): RecipeFileWrite
	/** Delete a file. Returns whether it existed. The old bytes are kept so the engine can restore them. */
	remove(path: string): boolean
	/**
	 * Declare files this recipe produces by other means (a spawned tool, a
	 * direct `node:fs` write) so the receipt lists them even when they did not
	 * change: `unchanged` on a rerun, which keeps `outputTreeHash` stable.
	 */
	own(...paths: string[]): void
}

/**
 * What `execute` and `compensate` of a `recipe.ts` receive as their third
 * argument. Everything a side-effect recipe needs to honour reruns and dry
 * runs is here; see docs/PACKS.md, "The `recipe.ts` contract".
 */
export interface RecipeContext extends StepContext {
	/** The pack this recipe belongs to; `root` is its directory (read-only: never write into it). */
	readonly pack: { readonly name: string; readonly version: string; readonly root: string }
	/** The project root recipes write into (also `state.targetDirectory`). */
	readonly projectRoot: string
	/** The run's `onExisting` policy. The default for `files.write`; a recipe that writes files by other means should honour it too. */
	readonly onExisting: OnExisting
	/**
	 * True in a dry run. A recipe may only run in one if its manifest sets
	 * `supportsDryRun`; it must then write only through `files` and must not
	 * spawn processes or touch anything else (Baka verifies the tree is unchanged afterwards).
	 */
	readonly dryRun: boolean
	readonly files: RecipeFiles
	/**
	 * The pack's `data/*.json` files, read-only: `data/versions.json` is
	 * `ctx.data.versions`. Empty when the pack ships none.
	 */
	readonly data: Readonly<Record<string, unknown>>
}

/**
 * The shape of a `recipe.ts` export: `execute` does the work and returns a
 * `StepResponse`; `compensate` undoes whatever `execute` did by means the
 * engine cannot see (the files written through `ctx.files` and by templates
 * are undone by the engine itself). Unlike a `WorkflowStep` it has no
 * `role`, so a pack needs no runtime import from `baka-sdk` at all: use
 * `import type`.
 */
export interface RecipeStep<TInput, TOutput, TCompensationData> {
	name?: string
	execute: (
		input: TInput,
		state: OrchestrationState,
		ctx: RecipeContext,
	) => Promise<StepResponse<TOutput, TCompensationData>>
	compensate: (data: TCompensationData, state: OrchestrationState, ctx: RecipeContext) => Promise<void>
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
	// Fixed sampling seed, forwarded to providers that support it (llama.cpp,
	// vLLM, OpenAI). Undefined means "do not send a seed" (server default).
	seed?: number
	// Free-form provider-specific options. Concrete providers (e.g. openai-compatible)
	// read only the keys they understand; everything else is ignored.
	providerOptions: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidationDiagnostic = {
	severity: "error" | "warning"
	/** The validator's own rule id; for a failed run, an RecipeErrorCode. */
	rule: string
	message: string
	file?: string
	hint?: string
	/** `<pack>:<id>` (pack-level) or `<pack>.<recipe>:<id>` (recipe-level) of the validator that produced it. */
	validator?: string
	/** The pack a discovery (structural) diagnostic is about. */
	pack?: string
}

/** `kind` is `fail` when any diagnostic is an error. Warnings are reported whichever it is. */
export type ValidationResult = { kind: "pass" | "fail"; diagnostics: ValidationDiagnostic[] }

export type LlmCall = z.infer<typeof LlmCallSchema>
export type ApiError = z.infer<typeof ApiErrorSchema>

/** What an add-on is told before a recipe runs. */
export interface AddonRunRequest {
	pack: string
	recipe: string
	/** The params after defaults and coercion: what the run will use. */
	params: Record<string, unknown>
	/** The pack as it is on disk now: its version and content hash. */
	pin: PackPin
	dryRun: boolean
	/** The directory the recipe writes into. */
	root: string
}

/**
 * The one extension point of the open engine (docs/CONTRACT.md, "Add-ons"). A closed package attaches
 * through a call's `addons` without patching anything: `beforeRun` may refuse a run by throwing,
 * before anything is written; `afterRun` sees every receipt, refused runs included. An add-on that
 * fails in `afterRun` cannot change the result: the receipt gains an `addon-failed` warning.
 */
export interface BakaAddon {
	name: string
	beforeRun?(request: AddonRunRequest): void | Promise<void>
	afterRun?(receipt: RecipeResult): void | Promise<void>
}
