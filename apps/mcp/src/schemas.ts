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
// Registry discovery tool input schemas (milestone 5,
// mcp-registry-tools feature; VAL-DISC-024/025/026/027/045).
//
// All three schemas are STRICT strings (no `any`, no loose coercion)
// so a malformed argument surfaces a structured validation error on
// the tool result (the MCP-spec tool-error channel). The MCP wire
// convention is: bad input → `isError: true` with the offending
// field named; never a JSON-RPC protocol error or a server crash
// (VAL-DISC-045).
//
// The schemas also refuse the bare-name space (`@scope/name`,
// `name`, `@scope/name@version`) — bare names like `"baka-base"`
// resolve to the official scope client-side. The MCP tool keeps
// the inputs narrow on purpose: it surfaces the SCOPE the host
// passed so the official scope is always explicit ("baka" rather
// than "resolve to official") and the agent client can name it
// back if needed.
//
// These schemas validate the wire shape — the tool handlers below
// re-run them per architecture convention.
// ---------------------------------------------------------------------------

export const RegistrySearchInputSchema = z.object({
	query: z
		.string()
		.min(1)
		.describe(
			"Search term matched case-insensitively against module scope, name, and description. Required; non-empty string.",
		),
})

export const RegistryGetModuleInputSchema = z.object({
	scope: z
		.string()
		.min(1)
		.describe("Module scope (typically the official org slug; e.g. 'baka' for first-party modules)."),
	name: z.string().min(1).describe("Module name (e.g. 'baka-base', 'sdd')."),
})

export const RegistryGetPreviewInputSchema = z.object({
	scope: z.string().min(1).describe("Module scope (e.g. 'baka')."),
	name: z.string().min(1).describe("Module name (e.g. 'sdd')."),
	version: z
		.string()
		.min(1)
		.describe("Version tag (e.g. '0.1.0'). Omitting the version resolves to the latest ready version (semver max)."),
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
