import {
	AgentRole,
	type LLMMessage,
	type LLMProvider,
	type LLMRequest,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Module design — the chat-driven double-diamond flow
//
// A single LLM turn. The CLI owns the chat REPL and calls `runDesignTurn`
// on every user message. The LLM responds with a structured object that
// the CLI renders and acts on. Phase transitions are driven by the LLM
// (it returns a `phase` field), not by the CLI.
//
// The same factory pattern as the Orchestrator: the provider is injected,
// no global state is read, the step is pure.
// ---------------------------------------------------------------------------

// ----- Structured output schemas (per phase) -------------------------------

const DiscoverQuestionSchema = z.object({
	id: z.string().describe("stable id for the question; the CLI uses it to address follow-ups"),
	prompt: z.string().describe("the question to ask the user; written as if speaking to a teammate"),
	whyWeNeedThis: z.string().describe("one sentence explaining why this matters for their module"),
})

const DiscoverPayloadSchema = z.object({
	phase: z.literal("DISCOVER"),
	message: z.string().describe("short, conversational message to render to the user (1-3 sentences)"),
	questions: z.array(DiscoverQuestionSchema).min(1).max(8).describe("questions to ask this turn"),
	synthesizedPrefs: z
		.string()
		.optional()
		.describe("if all the preferences needed are now known, write a markdown draft of PREFERENCES.md here; else omit"),
	finished: z.boolean().describe("true when the LLM is ready to move to the DEFINE phase"),
})

const ProposedActionSchema = z.object({
	id: z.string().describe("kebab-case action id, e.g. 'scaffold' or 'add-route'"),
	description: z.string().describe("one-line description of what this action does"),
	rationale: z.string().describe("one sentence explaining why this action belongs in the module"),
})

const DefinePayloadSchema = z.object({
	phase: z.literal("DEFINE"),
	message: z.string().describe("short, conversational message"),
	actions: z.array(ProposedActionSchema).min(1).describe("the proposed action roster"),
	finished: z.boolean().describe("true when the LLM is ready to move to DEVELOP"),
})

const DesignedParamSchema = z.object({
	name: z.string().describe("camelCase param name"),
	type: z.enum(["string", "number", "boolean", "enum"]).describe("param type"),
	required: z.boolean().describe("whether the LLM must supply this value in a plan"),
	description: z.string().describe("what this param means"),
	enumValues: z.array(z.string()).optional().describe("required when type=enum"),
})

const DesignedValidatorSchema = z.object({
	id: z.string().describe("kebab-case validator id; becomes the file name"),
	purpose: z.string().describe("one-line purpose"),
})

const DesignedTemplateSchema = z.object({
	id: z.string().describe("kebab-case template id; becomes the file name"),
	outline: z.string().describe("the handlebars template outline the LLM will fill in at run time"),
})

const DesignedActionSchema = z.object({
	id: z.string().describe("matches a ProposedAction id"),
	params: z.array(DesignedParamSchema).describe("parameter schema for this action"),
	requiresReasoning: z
		.boolean()
		.describe("true if this action should call the LLM at run time to fill handlebars templates"),
	compensatesWith: z.string().nullable().describe("id of the action that compensates this one, or null"),
	validators: z.array(DesignedValidatorSchema).describe("action-level validators"),
	templates: z.array(DesignedTemplateSchema).optional().describe("required when requiresReasoning: true"),
	testIntent: z
		.string()
		.describe("a representative user intent that should trigger this action; used for the consistency test"),
})

const DevelopPayloadSchema = z.object({
	phase: z.literal("DEVELOP"),
	message: z.string().describe("short, conversational message"),
	actions: z.array(DesignedActionSchema).min(1).describe("designed actions; one per ProposedAction id"),
	finished: z.boolean().describe("true when all actions are designed and the LLM is ready to DELIVER"),
})

const DeliverPayloadSchema = z.object({
	phase: z.literal("DELIVER"),
	message: z.string().describe("short, conversational summary message"),
	readmeSummary: z.string().describe("one paragraph for the auto-generated README"),
	finished: z.boolean().describe("true when delivery (file write + validate + consistency) should proceed"),
})

export const DesignTurnPayloadSchema = z.discriminatedUnion("phase", [
	DiscoverPayloadSchema,
	DefinePayloadSchema,
	DevelopPayloadSchema,
	DeliverPayloadSchema,
])

export type DesignTurnPayload = z.infer<typeof DesignTurnPayloadSchema>

// ----- Input ---------------------------------------------------------------

export interface DesignTurnInput {
	phase: "DISCOVER" | "DEFINE" | "DEVELOP" | "DELIVER" | "DONE"
	// The user's free-form description of what the module should cover.
	brief: string
	// The chat history maintained by the CLI. The CLI appends to this on every
	// turn; we send it to the LLM in full so it has the conversation context.
	history: LLMMessage[]
	// Whatever has been synthesized so far, if any. Lets the LLM continue
	// from where the CLI left off.
	prefs?: string
	roster?: Array<{ id: string; description: string; rationale: string }>
	designedActions?: Array<z.infer<typeof DesignedActionSchema>>
}

export interface DesignTurnOutput {
	// The LLM's structured response.
	payload: DesignTurnPayload
	// The full updated chat history (input.history + this turn's exchange).
	history: LLMMessage[]
}

// ----- Step factory --------------------------------------------------------

const SYSTEM_PROMPT_HEADER = `You are the baka Module Designer. You help the user design a new baka module through a chat-driven double-diamond process.

Baka modules enforce the user's patterns for LLM-assisted development. A module is a self-contained set of typed actions the LLM can plan and execute. The module's contract is its manifest; its behavior is its actions; its quality bar is its validators. The actions you design here will be invoked by future LLM agents, so the param schema, the rationale, the validators — all of it must be precise.

The flow has four phases: DISCOVER (diverge — learn the user's domain and preferences), DEFINE (converge — propose the action roster), DEVELOP (per action, design params/validators/templates), DELIVER (synthesize, hand back, run consistency). You drive the flow by setting the \`phase\` field. The user can rewind, skip, or go back at any time; respect their intent.

Always respond with a single JSON object that matches the schema for the current phase. The \`message\` field is what the user sees — keep it short and conversational. The \`structured\` fields are what the CLI uses to advance state — keep them precise.

You are not writing code in this turn. The CLI writes the code in the DELIVER phase. Your job is to elicit the user's preferences and converge on a clean design.

The four phases and their jobs:

DISCOVER
- Ask 3-6 clarifying questions per turn. Don't ask everything at once.
- After the user has answered enough, write a markdown PREFERENCES.md draft in \`synthesizedPrefs\` and set \`finished: true\`.
- The PREFERENCES.md is the source of truth for the user's preferences for this module. It must include:
  - A "## Domain" section describing what the module covers
  - A "## Conventions" section listing the user's specific style/structural preferences
  - A "## Anti-patterns" section listing what to forbid
  - A "## Examples" section with one or two snippets the user pointed to

DEFINE
- Propose a list of 3-10 actions that cover the module's domain. Each action has an id, a description, and a one-sentence rationale.
- Be opinionated. The user can edit; your job is to give a strong starting point.
- Cover the obvious CRUD, then the high-value nuances (compensations, error paths).
- When the user says the list is right, set \`finished: true\`.

DEVELOP
- For every action in the roster, design:
  - params: an array of {name, type, required, description, [enumValues]}. Keep param count low (3-7).
  - requiresReasoning: true if the action calls the LLM at run time
  - compensatesWith: id of the inverse action, or null
  - validators: 1-4 action-level validators (id + purpose)
  - templates: required if requiresReasoning, the handlebars outline the LLM fills at run time
  - testIntent: a single representative user intent that should trigger this action
- When all actions are designed, set \`finished: true\`.

DELIVER
- Set \`readmeSummary\` to a one-paragraph description of the module.
- Set \`finished: true\`.
- The CLI will write the files, run validation, and run the 5x consistency test.`

export function createModuleDesignStep(provider: LLMProvider): WorkflowStep<DesignTurnInput, DesignTurnOutput, null> {
	return {
		name: "module-design-turn",
		role: AgentRole.ORCHESTRATOR,

		execute: async (input): Promise<StepResponse<DesignTurnOutput, null>> => {
			try {
				const phaseHint = `Current phase: ${input.phase}\n\n${contextSummary(input)}`
				const messages: LLMMessage[] = [
					{ role: "system", content: SYSTEM_PROMPT_HEADER },
					{ role: "system", content: phaseHint },
					...input.history,
				]

				const request: LLMRequest = {
					model: "",
					messages,
					responseSchema: DesignTurnPayloadSchema,
					temperature: 0.2, // small amount of creative latitude during the design chat
				}

				const response = await provider.chat<DesignTurnPayload>(request)
				const payload = response.content
				// Append the assistant's structured response to the history as a
				// compact text representation (we don't need the full JSON in
				// history; the CLI keeps the parsed payload in state).
				const summary = `${payload.message}\n\n[phase=${payload.phase}]`
				const updatedHistory: LLMMessage[] = [...input.history, { role: "assistant", content: summary }]
				return {
					success: true,
					output: { payload, history: updatedHistory },
					compensationData: null,
				}
			} catch (err) {
				return {
					success: false,
					output: { payload: fallbackError(input.phase, err), history: input.history },
					compensationData: null,
					error: err instanceof Error ? err.message : String(err),
				}
			}
		},

		compensate: async () => {
			// The design turn is read-only — it does not mutate the project.
		},
	}
}

function contextSummary(input: DesignTurnInput): string {
	const lines: string[] = [`User's brief: ${input.brief || "(none)"}`]
	if (input.prefs) {
		lines.push("Current PREFERENCES.md draft:")
		lines.push(input.prefs)
	}
	if (input.roster && input.roster.length > 0) {
		lines.push("Current action roster:")
		for (const a of input.roster) lines.push(`  - ${a.id}: ${a.description} (${a.rationale})`)
	}
	if (input.designedActions && input.designedActions.length > 0) {
		lines.push("Already designed actions:")
		for (const a of input.designedActions) {
			lines.push(
				`  - ${a.id}: ${a.params.length} params, ${a.validators.length} validators, requiresReasoning=${a.requiresReasoning}`,
			)
		}
	}
	return lines.join("\n")
}

function fallbackError(phase: DesignTurnInput["phase"], err: unknown): DesignTurnPayload {
	const message = err instanceof Error ? err.message : String(err)
	if (phase === "DISCOVER") {
		return {
			phase: "DISCOVER",
			message: `The LLM returned an error. Tell me what's still unclear or type /skip to use a sensible default.\n\n(error: ${message})`,
			questions: [
				{
					id: "domain",
					prompt: "What domain does this module cover?",
					whyWeNeedThis: "I need a one-sentence framing of the module's purpose.",
				},
			],
			finished: false,
		}
	}
	if (phase === "DEFINE") {
		return {
			phase: "DEFINE",
			message: `The LLM returned an error. Type /skip to use a default action roster based on the brief.\n\n(error: ${message})`,
			actions: [
				{
					id: "init",
					description: "Default boilerplate initialization routine",
					rationale: "Fallback action when the LLM cannot propose a roster.",
				},
			],
			finished: false,
		}
	}
	if (phase === "DEVELOP") {
		return {
			phase: "DEVELOP",
			message: `The LLM returned an error. Type /skip to use a minimal default param schema for each action.\n\n(error: ${message})`,
			actions: [],
			finished: false,
		}
	}
	return {
		phase: "DELIVER",
		message: `The LLM returned an error. Type /skip to proceed to delivery anyway.\n\n(error: ${message})`,
		readmeSummary: "Auto-generated module.",
		finished: false,
	}
}

// ----- Helpers used by the CLI's DELIVER phase ----------------------------

/**
 * Build the PREFERENCES.md file from the synthesized text returned in
 * the DISCOVER payload. Wraps the body in YAML frontmatter that captures
 * the module name and the date, so future agents can parse it.
 */
export function renderPreferencesFile(moduleName: string, prefsBody: string): string {
	const today = new Date().toISOString().slice(0, 10)
	const safeBody = prefsBody.trim() || "_(no preferences synthesized yet)_"
	return `---
module: ${moduleName}
generatedAt: ${today}
---

${safeBody}
`
}

/**
 * Build the manifest.ts source from a confirmed roster + designed actions.
 * Pure function: no LLM, no file I/O. Used by the DELIVER phase and by
 * unit tests.
 */
export function renderManifestSource(
	moduleName: string,
	description: string,
	deps: string[],
	actions: Array<{
		id: string
		description: string
		params: Array<{ name: string; type: string; required: boolean; description: string; enumValues?: string[] }>
		requiresReasoning: boolean
		compensatesWith: string | null
		validators: Array<{ id: string; purpose: string }>
	}>,
): string {
	const manifest = {
		name: moduleName,
		version: "0.1.0",
		description: description || "Auto-generated module.",
		dependencies: deps,
		conflictsWith: [],
		actions: actions.map((a) => ({
			id: a.id,
			description: a.description,
			params: a.params.map((p) => ({
				name: p.name,
				type: p.type,
				required: p.required,
				description: p.description,
				...(p.enumValues ? { enumValues: p.enumValues } : {}),
			})),
			requiresReasoning: a.requiresReasoning,
			...(a.compensatesWith ? { compensatesWith: a.compensatesWith } : {}),
			validators: a.validators.map((v) => v.id),
		})),
		moduleValidators: [],
	}
	return `import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = ${JSON.stringify(manifest, null, "\t")}
`
}

/**
 * Build the action.ts stub for a designed action. The body is a TODO with
 * the param interface and compensationData shape already typed in, so the
 * module author only has to fill in the body.
 */
export function renderActionStubSource(action: {
	id: string
	description: string
	params: Array<{ name: string; type: string; required: boolean; description: string; enumValues?: string[] }>
	requiresReasoning: boolean
	compensatesWith: string | null
}): string {
	const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
	const inputType = `${cap(action.id)}Input`
	const compType = `${cap(action.id)}CompensationData`
	const paramsType = (p: { type: string; enumValues?: string[] }): string => {
		switch (p.type) {
			case "string":
				return "string"
			case "number":
				return "number"
			case "boolean":
				return "boolean"
			case "enum":
				return p.enumValues && p.enumValues.length > 0 ? p.enumValues.map((v) => `"${v}"`).join(" | ") : "string"
			default:
				return "unknown"
		}
	}
	const paramFields = action.params.map((p) => `\t${p.name}${p.required ? "" : "?"}: ${paramsType(p)}`).join("\n")

	return `import type { ActionFn, CompensationFn } from "baka-sdk"

/**
 * ${action.description}
 */
export interface ${inputType} {
${paramFields || "\t// no params"}
}

export interface ${compType} {
\ttargetDirectory: string
\tactionData: ${inputType}
\tcreatedFiles: string[]
}

export const ${action.id}: ActionFn<${inputType}, ${compType}> = async (input, state) => {
\t// TODO: implement the action body. Use the params from \`input\`, write into
\t// \`state.targetDirectory\`, and return a list of files you created so the
\t// validators can inspect them.
\treturn {
\t\tcompensationData: {
\t\t\ttargetDirectory: state.targetDirectory,
\t\t\tactionData: input,
\t\t\tcreatedFiles: [],
\t\t},
\t}
}

export const compensate: CompensationFn<${compType}> = async (data) => {
\t// TODO: undo what the action did. Delete files in data.createdFiles.
\tvoid data
}
`
}

/**
 * Build a stub validator file. Returns [] so the action always passes
 * until the author fills in real checks.
 */
export function renderValidatorStubSource(validatorId: string, purpose: string): string {
	return `import type { ActionValidatorFn } from "baka-sdk"

/**
 * ${purpose}
 */
export const validator: ActionValidatorFn = async (_state, _actionData) => {
\t// TODO: inspect _state.targetDirectory and the files the action produced
\t// (in _actionData.compensationData.createdFiles). Return one diagnostic
\t// per finding. Return [] to pass.
\treturn []
}
`
}

/**
 * Build a handlebars template stub. The CLI writes the outline from the
 * LLM's DEVELOP payload into the template; the Worker fills it in at run
 * time.
 */
export function renderTemplateStubSource(actionId: string, templateId: string, outline: string): string {
	return `{{!--
  Action: ${actionId}
  Template: ${templateId}
  Outline (filled by the Worker at run time via the LLM):
${outline
	.split("\n")
	.map((l) => `  ${l}`)
	.join("\n")}
--}}
{{{body}}}
`
}
