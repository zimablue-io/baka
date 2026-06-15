import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { createContext, getModules, type ServerContext } from "./context.js"
import { DESIGN_MODULE_DESCRIPTION, DESIGN_MODULE_PROMPT_NAME, designModuleMessages } from "./prompts/design-module.js"
import {
	listModulesResource,
	MODULE_MANIFEST_TEMPLATE_METADATA,
	MODULE_MANIFEST_URI_TEMPLATE_STRING,
	MODULES_RESOURCE_URI,
	moduleManifestUri,
	readModuleManifestResource,
	readModulesResource,
} from "./resources/modules.js"
import {
	ApplyInputSchema,
	actionParamsToZodSchema,
	DesignModuleArgsShape,
	ListActionsInputSchema,
	PlanInputSchema,
	ValidateInputSchema,
} from "./schemas.js"
import { runAction, runApply, runListActions, runPlan, runValidate } from "./tools/workflow.js"

const SERVER_NAME = "baka-mcp"
const SERVER_VERSION = "0.1.0"

export interface StartServerOptions {
	cwd: string
}

export function startServer(opts: StartServerOptions): McpServer {
	const ctx = createContext(opts.cwd)
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

	registerWorkflowTools(server, ctx)
	registerActionTools(server, ctx)
	registerResources(server, ctx)
	registerPrompts(server)

	return server
}

// ---------------------------------------------------------------------------
// Workflow-level tools
// ---------------------------------------------------------------------------

function registerWorkflowTools(server: McpServer, ctx: ServerContext): void {
	server.registerTool(
		"baka_plan",
		{
			description:
				"Plan a feature intent into a Zod-validated sequence of {module, action, params} steps. Returns the resolved plan; the LLM cannot invent modules or actions. To execute the plan, use baka_apply with the --save output, or call baka_<module>_<action> tools directly.",
			inputSchema: PlanInputSchema.shape,
		},
		async (raw) => {
			const input = PlanInputSchema.parse(raw)
			const result = await runPlan(ctx, input.intent, {
				dryRun: input.dryRun,
				save: input.save,
			})
			return jsonResult(result)
		},
	)

	server.registerTool(
		"baka_apply",
		{
			description:
				"Apply a saved plan file. Loads the plan, runs the SAGA with SAGA compensation, and runs all module validators. Returns the per-step status, failure (if any), and validator diagnostics.",
			inputSchema: ApplyInputSchema.shape,
		},
		async (raw) => {
			const input = ApplyInputSchema.parse(raw)
			const result = await runApply(ctx, input.planFile)
			return jsonResult(result)
		},
	)

	server.registerTool(
		"baka_validate",
		{
			description:
				"Run all module validators (structural + module-level + action-level) against the current project tree. Returns pass/fail with structured diagnostics.",
			inputSchema: ValidateInputSchema.shape,
		},
		async () => {
			const result = await runValidate(ctx)
			return jsonResult(result)
		},
	)

	server.registerTool(
		"baka_list_actions",
		{
			description:
				"List the actions declared by a module, including each action's params, validators, and compensation pointer. The finite, declared action space baka constrains the LLM to is exactly this list.",
			inputSchema: ListActionsInputSchema.shape,
		},
		async (raw) => {
			const input = ListActionsInputSchema.parse(raw)
			const result = await runListActions(ctx, input.module)
			return jsonResult(result)
		},
	)
}

// ---------------------------------------------------------------------------
// Per-action tools (one per {module, action})
// ---------------------------------------------------------------------------

function registerActionTools(server: McpServer, ctx: ServerContext): void {
	for (const m of getModules(ctx)) {
		for (const a of m.actions) {
			const toolName = actionToolName(m.name, a.id)
			const description = formatActionDescription(m, a)
			const shape = actionParamsToZodSchema(a).shape

			server.registerTool(
				toolName,
				{
					description,
					inputSchema: shape,
				},
				async (raw) => {
					const params = (raw ?? {}) as Record<string, unknown>
					const result = await runAction(ctx, m.name, a.id, params)
					return jsonResult(result)
				},
			)
		}
	}
}

function actionToolName(moduleName: string, actionId: string): string {
	// MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$. We also normalize
	// hyphens to underscores so the names are pure snake_case, which is
	// easier to type in agent tool calls and is consistent across the
	// surface (workflow tools use `baka_plan`, not `baka-plan`).
	const safe = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_")
	return `baka_${safe(moduleName)}_${safe(actionId)}`
}

function formatActionDescription(
	module: { name: string; version: string },
	action: { id: string; description: string; requiresReasoning: boolean; compensatesWith?: string },
): string {
	const lines = [`[${module.name} v${module.version}] ${action.id}: ${action.description}`]
	if (action.requiresReasoning) {
		lines.push("This action requires an LLM provider (configured via `baka init`); it will throw if none is available.")
	}
	if (action.compensatesWith) {
		lines.push(`On failure, the SAGA rolls back via \`${action.compensatesWith}\`.`)
	}
	return lines.join(" ")
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

function registerResources(server: McpServer, ctx: ServerContext): void {
	// baka://modules — directory of all modules
	server.registerResource(
		"baka-modules",
		MODULES_RESOURCE_URI,
		{
			description: listModulesResource(ctx).description,
			mimeType: "application/json",
		},
		async (uri): Promise<ReadResourceResult> => {
			void uri
			return readModulesResource(ctx)
		},
	)

	// baka://module/{name}/manifest — full manifest for one module
	server.registerResource(
		"baka-module-manifest",
		new ResourceTemplate(MODULE_MANIFEST_URI_TEMPLATE_STRING, { list: undefined }),
		{
			description: MODULE_MANIFEST_TEMPLATE_METADATA.description,
			mimeType: MODULE_MANIFEST_TEMPLATE_METADATA.mimeType,
		},
		async (uri): Promise<ReadResourceResult> => readModuleManifestResource(ctx, uri.href),
	)
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function registerPrompts(server: McpServer): void {
	server.registerPrompt(
		DESIGN_MODULE_PROMPT_NAME,
		{
			description: DESIGN_MODULE_DESCRIPTION,
			argsSchema: DesignModuleArgsShape,
		},
		(args) => {
			const parsed = z
				.object({
					name: DesignModuleArgsShape.name,
					resume: DesignModuleArgsShape.resume,
				})
				.parse(args)
			return {
				messages: designModuleMessages(parsed),
			}
		},
	)
}

// ---------------------------------------------------------------------------
// Output helper
// ---------------------------------------------------------------------------

function jsonResult(value: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(value, null, 2),
			},
		],
	}
}

// Re-exported for the test
export { actionToolName, moduleManifestUri }
