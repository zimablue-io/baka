import type { ModuleAction, ModuleActionParam } from "@repo/protocol"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Workflow-level tool input schemas
// ---------------------------------------------------------------------------

export const PlanInputSchema = z.object({
	intent: z.string().min(1).describe("The user intent to plan, e.g. 'set up a Next.js app with auth'."),
	dryRun: z.boolean().optional().describe("If true, do not execute the plan after planning."),
	save: z.boolean().optional().describe("If true, persist the plan to .baka/plans/."),
})

export const ApplyInputSchema = z.object({
	planFile: z.string().min(1).describe("Path to a saved plan file (relative to cwd or absolute)."),
})

export const ValidateInputSchema = z.object({})

export const ListActionsInputSchema = z.object({
	module: z.string().min(1).describe("Module name to list actions for."),
})

// ---------------------------------------------------------------------------
// Per-action param -> Zod object schema
// ---------------------------------------------------------------------------

/**
 * Build a Zod object schema for an action's declared params. Used to
 * generate the `inputSchema` for each per-action MCP tool.
 */
export function actionParamsToZodSchema(action: Pick<ModuleAction, "params">): z.ZodObject<z.ZodRawShape> {
	// The `shape` is the plain record that `z.object` accepts; we build it
	// from the action's param list and pass it straight through.
	const shape: z.ZodRawShape = {}
	for (const p of action.params as ModuleActionParam[]) {
		shape[p.name] = paramToZod(p)
	}
	return z.object(shape)
}

function paramToZod(p: ModuleActionParam): z.ZodTypeAny {
	let base: z.ZodTypeAny
	switch (p.type) {
		case "string":
			base = z.string()
			break
		case "number":
			base = z.number()
			break
		case "boolean":
			base = z.boolean()
			break
		case "enum": {
			if (!p.enumValues || p.enumValues.length === 0) {
				throw new Error(`action param "${p.name}" has type enum but no enumValues`)
			}
			base = z.enum(p.enumValues as [string, ...string[]])
			break
		}
	}
	const described = base.describe(p.description)
	return p.required ? described : described.optional()
}

// ---------------------------------------------------------------------------
// Prompt argument shape
// ---------------------------------------------------------------------------

/**
 * Args schema for the `baka_design_module` prompt. Zod-typed so the host
 * validates the user's input shape before invoking the prompt.
 */
export const DesignModuleArgsShape = {
	name: z.string().min(1).describe("Module name to design (kebab-case)."),
	resume: z.boolean().optional().describe("Set true to resume an in-progress design from .baka/state/."),
} as const
