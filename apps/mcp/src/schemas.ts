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
// `name`, `@scope/name@version`) — bare names like `"hello"`
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
	name: z.string().min(1).describe("Module name (e.g. 'hello')."),
})

export const RegistryGetPreviewInputSchema = z.object({
	scope: z.string().min(1).describe("Module scope (e.g. 'baka')."),
	name: z.string().min(1).describe("Module name (e.g. 'hello')."),
	version: z
		.string()
		.min(1)
		.describe("Version tag (e.g. '0.1.0'). Omitting the version resolves to the latest ready version (semver max)."),
})

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
