import { z } from "zod"

// ---------------------------------------------------------------------------
// Structured payload the LLM returns on every turn.
//
// The CLI does not import this; only the workflow does. The state machine
// consumes the payload and returns a new DesignSessionState.
// ---------------------------------------------------------------------------

const DiscoverQuestionSchema = z.object({
	id: z.string(),
	prompt: z.string(),
	whyWeNeedThis: z.string(),
})

const DiscoverPayloadSchema = z.object({
	phase: z.literal("DISCOVER"),
	message: z.string(),
	questions: z.array(DiscoverQuestionSchema).min(0).max(8),
	synthesizedPrefs: z.string().optional(),
	finished: z.boolean(),
})

const ProposedActionSchema = z.object({
	id: z.string(),
	description: z.string(),
	rationale: z.string(),
})

const DefinePayloadSchema = z.object({
	phase: z.literal("DEFINE"),
	message: z.string(),
	actions: z.array(ProposedActionSchema),
	finished: z.boolean(),
})

const DesignedParamSchema = z.object({
	name: z.string(),
	type: z.enum(["string", "number", "boolean", "enum"]),
	required: z.boolean(),
	description: z.string(),
	enumValues: z.array(z.string()).optional(),
})

const DesignedValidatorSchema = z.object({
	id: z.string(),
	purpose: z.string(),
})

const DesignedTemplateSchema = z.object({
	id: z.string(),
	outline: z.string(),
})

const DesignedActionSchema = z.object({
	id: z.string(),
	params: z.array(DesignedParamSchema),
	requiresReasoning: z.boolean(),
	compensatesWith: z.string().nullable(),
	validators: z.array(DesignedValidatorSchema),
	templates: z.array(DesignedTemplateSchema).optional(),
	testIntent: z.string(),
})

const DevelopPayloadSchema = z.object({
	phase: z.literal("DEVELOP"),
	message: z.string(),
	actions: z.array(DesignedActionSchema),
	finished: z.boolean(),
})

const DeliverPayloadSchema = z.object({
	phase: z.literal("DELIVER"),
	message: z.string(),
	readmeSummary: z.string(),
	finished: z.boolean(),
})

export const DesignTurnPayloadSchema = z.discriminatedUnion("phase", [
	DiscoverPayloadSchema,
	DefinePayloadSchema,
	DevelopPayloadSchema,
	DeliverPayloadSchema,
])

export type DesignTurnPayload = z.infer<typeof DesignTurnPayloadSchema>
export type ProposedAction = z.infer<typeof ProposedActionSchema>
export type DesignedActionSchema = z.infer<typeof DesignedActionSchema>
