import { z } from "zod"
import { ENGINE_STATUS } from "./constants"
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
