import { z } from "zod"
import { ENGINE_STATUS } from "./constants"
import { AgentRole } from "./types"

export const ModuleActionParamSchema = z.object({
	name: z.string(),
	type: z.enum(["string", "boolean", "number"]),
	required: z.boolean(),
	description: z.string(),
})

export const ModuleActionSchema = z.object({
	id: z.string(),
	description: z.string(),
	params: z.array(ModuleActionParamSchema),
})

export const ModuleManifestSchema = z.object({
	name: z.string(),
	version: z.string(),
	dependencies: z.array(z.string()),
	actions: z.array(ModuleActionSchema),
})

export const OrchestrationStateSchema = z.object({
	userIntent: z.string(),
	targetDirectory: z.string(),
	status: z.nativeEnum(ENGINE_STATUS),
	currentRole: z.nativeEnum(AgentRole).optional(),
	executionPlan: z.object({
		steps: z.array(
			z.object({
				id: z.string(),
				module: z.string(),
				action: z.string(),
				params: z.record(z.any()),
			}),
		),
		currentStepIndex: z.number(),
	}),
	logs: z.array(z.string()),
	artifacts: z.record(z.any()).default({}),
})
