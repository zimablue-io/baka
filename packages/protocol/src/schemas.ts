import { z } from "zod"
import { ACTION_ERROR_CODES, ENGINE_STATUS } from "./constants"
import { AgentRole } from "./types"

// ---------------------------------------------------------------------------
// Module manifest
// ---------------------------------------------------------------------------

export const ModuleActionParamSchema = z.object({
	name: z.string().min(1),
	type: z.enum(["string", "boolean", "number", "enum"]),
	required: z.boolean(),
	description: z.string(),
	enumValues: z.array(z.string()).optional(), // required when type === "enum"
})

export const ModuleActionSchema = z.object({
	id: z.string().min(1),
	description: z.string(),
	params: z.array(ModuleActionParamSchema),
	requiresReasoning: z.boolean().default(false),
	compensatesWith: z.string().optional(),
	filePatterns: z.array(z.string()).default([]),
	validators: z.array(z.string()).default([]),
	/**
	 * Optional toolchain the registry should run against the
	 * dry-run output for this action. Today only `tsc` is
	 * declarable (architecture §4.6 layer 3); the closed set is
	 * a deliberate cap so the registry can stay honest about
	 * what tools it runs and how their failures are surfaced.
	 */
	toolchain: z.enum(["tsc"]).optional(),
})

// ---------------------------------------------------------------------------
// Slot-native templates (docs/superpowers/specs/2026-08-25-slot-native-templates.md)
// ---------------------------------------------------------------------------

export const SlotKindSchema = z.enum(["prose", "ident", "list", "json"])

export const SlotDeclSchema = z.object({
	id: z.string().min(1),
	kind: SlotKindSchema,
	hint: z.string(),
	file: z.string().min(1),
	max: z.number().int().positive().optional(),
	item: z.string().optional(),
	schemaPath: z.string().optional(),
})

export const SlotFillSchema = z.object({
	value: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]),
})

export const ModuleManifestSchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	description: z.string().default(""),
	dependencies: z.array(z.string()).default([]),
	conflictsWith: z.array(z.string()).default([]),
	actions: z.array(ModuleActionSchema).min(1),
	moduleValidators: z.array(z.string()).default([]),
})

// ---------------------------------------------------------------------------
// Resolved plan (output of the Orchestrator, input to the Worker)
// ---------------------------------------------------------------------------

export const ResolvedPlanStepSchema = z.object({
	id: z.string(),
	module: z.string(),
	action: z.string(),
	params: z.record(z.any()),
})

export const ResolvedPlanSchema = z.object({
	resolvedSteps: z.array(ResolvedPlanStepSchema),
})

// ---------------------------------------------------------------------------
// Orchestration state
// ---------------------------------------------------------------------------

export const OrchestrationStateSchema = z.object({
	userIntent: z.string(),
	targetDirectory: z.string(),
	status: z.nativeEnum(ENGINE_STATUS),
	currentRole: z.nativeEnum(AgentRole).optional(),
	executionPlan: z.object({
		steps: z.array(ResolvedPlanStepSchema),
		currentStepIndex: z.number(),
	}),
	logs: z.array(z.string()),
	artifacts: z.record(z.any()).default({}),
})

// ---------------------------------------------------------------------------
// Action result (the receipt `runAction` returns; also the CLI/MCP/HTTP `--json` shape)
// ---------------------------------------------------------------------------

export const ActionErrorCodeSchema = z.enum(ACTION_ERROR_CODES)

export const ValidationDiagnosticSchema = z.object({
	severity: z.enum(["error", "warning"]),
	rule: z.string(),
	message: z.string(),
	file: z.string().optional(),
	hint: z.string().optional(),
})

/**
 * What happened to one path.
 * - `create`: the file did not exist and was written.
 * - `update`: the file existed with other content and was rewritten.
 * - `delete`: the file existed before and is gone after (side-effect actions only).
 * - `unchanged`: the file already held exactly the bytes the action would write.
 * - `skip`: the file exists with other content and the action left it alone.
 */
export const ChangeOpSchema = z.enum(["create", "update", "delete", "unchanged", "skip"])

export const ChangeReasonSchema = z.enum(["identical", "already-exists"])

export const ChangesetEntrySchema = z.object({
	/** Project-relative POSIX path. */
	path: z.string(),
	op: ChangeOpSchema,
	/** sha256 (lowercase hex) of the file's bytes after the action; null for `delete`. */
	contentHash: z.string().nullable(),
	/** Why nothing was written: `identical` for `unchanged`, `already-exists` for `skip`. */
	reason: ChangeReasonSchema.optional(),
	/** The file's UTF-8 text after the action. Only present when the caller asked for content, and never for `delete` or `skip`. */
	content: z.string().optional(),
})

export const SlotRecordSchema = z.object({
	id: z.string(),
	/**
	 * Model-independent identity of the fill: sha256 over the template bytes,
	 * the slot id, and the canonical params. A replay only accepts a record
	 * whose key matches the slot it is about to fill.
	 */
	key: z.string(),
	/** The model that produced the value (`manual` for a pinned fill). */
	model: z.string(),
	value: SlotFillSchema.shape.value,
	source: z.enum(["llm", "cache", "replay"]),
})

export const ActionCompensationSchema = z.object({
	/** Paths this run created; compensation deletes them. */
	created: z.array(z.string()),
	/** Files this run overwrote, with their previous bytes; compensation restores them. */
	overwritten: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
	/** What the action's own `execute` returned as compensation data; handed back to its `compensate`. */
	actionData: z.unknown(),
})

export const ActionResultSchema = z.object({
	ok: z.boolean(),
	module: z.string(),
	action: z.string(),
	/** Error diagnostics (a failed run carries one whose `rule` is an ActionErrorCode) plus validator output. */
	diagnostics: z.array(ValidationDiagnosticSchema),
	changeset: z.array(ChangesetEntrySchema),
	/** sha256 over the canonical (path, contentHash) list of the changeset; see docs/MODULES.md. */
	outputTreeHash: z.string(),
	slots: z.array(SlotRecordSchema),
	compensation: ActionCompensationSchema,
	/** What the action's `execute` returned (side-effect actions); null for template-only actions. */
	output: z.unknown(),
	dryRun: z.boolean(),
})
