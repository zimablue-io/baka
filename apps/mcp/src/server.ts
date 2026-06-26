import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import {
	ErrorCode,
	type InitializeRequest,
	InitializeRequestSchema,
	LATEST_PROTOCOL_VERSION,
	McpError,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js"
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

// Read the MCP server's version from its own package.json at runtime.
//
// This mirrors apps/cli/src/index.ts:30-36 exactly. The single-source
// invariant (architecture invariant 7: root package.json drives
// apps/cli/package.json AND apps/mcp/package.json, both bundled
// servers report matching versions) is preserved by reading the
// version from the local package.json instead of hardcoding it. After
// `scripts/release.sh <version>` bumps the three package.json files
// together, the dist artifact's `initialize` response reports the new
// version on the very next build — no separate string to drift.
//
// Why runtime read over build-time `tsup define`:
// - Matches the CLI's established pattern (consistency).
// - tsup preserves `import.meta.url` in the bundle, so
//   `fileURLToPath(import.meta.url)` resolves to the dist file's own
//   path at runtime. Verified at apps/cli/dist/index.js:25912.
// - Avoids a build-time substitution that could silently disagree
//   with the source package.json if the build is re-run against a
//   stale source.
//
// `__dirname` resolves to:
// - `apps/mcp/dist` in built mode (`pnpm --filter @baka/mcp-server build`).
// - `apps/mcp/src` in dev mode (`pnpm --filter @baka/mcp-server dev`).
// Either way, `../package.json` points at `apps/mcp/package.json`.
const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string }
const SERVER_VERSION = serverPkg.version

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

	// One structured stderr log line per successful `tools/call`. The MCP
	// SDK does not surface stderr logs out of the box, but the validation
	// contract (VAL-MCP-025) requires one structured line per call. Logs
	// are tagged with the tool name and a per-call id; stdout is untouched
	// (the JSON-RPC stream lives there).
	installToolCallLogging(server)

	// Concurrent initialize requests are rejected cleanly (VAL-MCP-023).
	// The MCP SDK's default behavior is to accept subsequent inits; the
	// contract requires rejection. We replace the init handler with one
	// that tracks state and throws InvalidRequest on the second call.
	installInitializeGuard(server)

	return server
}

// ---------------------------------------------------------------------------
// Stderr tool-call logging (VAL-MCP-025)
// ---------------------------------------------------------------------------

interface ToolResultLike {
	isError?: boolean
}

function logToolCall(toolName: string, callId: string, status: "ok" | "error", extra?: Record<string, unknown>): void {
	const entry = {
		ts: new Date().toISOString(),
		level: status === "ok" ? "info" : "error",
		source: "baka-mcp.tool",
		message: "tool call",
		tool: toolName,
		callId,
		status,
		...(extra ?? {}),
	}
	try {
		process.stderr.write(`${JSON.stringify(entry)}\n`)
	} catch {
		// Logging must never throw; a write failure here would propagate up
		// and break the MCP response path.
	}
}

function newCallId(): string {
	return `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Wrap each registered tool's callback so that one structured stderr log
 * line is emitted per invocation. Logs tagged with the tool name (so the
 * validator can grep for it) and a per-call id.
 */
function installToolCallLogging(server: McpServer): void {
	// The MCP SDK's tools/call handler dispatches into the registered
	// tool callbacks. We can't replace the dispatch from here without
	// re-implementing validation, so we hook into the McpServer's
	// tool registry by wrapping each callback at registration time.
	// (The MCP server has no public "wrap all" API; the alternative is
	// to override `CallToolRequestSchema`, which would force us to
	// re-implement schema validation. The wrap-each-callback approach
	// is the minimal, behavior-preserving one.)
	const registered = (server as unknown as { _registeredTools?: Record<string, { handler: unknown }> })._registeredTools
	if (!registered) return
	for (const [name, entry] of Object.entries(registered)) {
		const original = entry.handler as (input: unknown, extra: unknown) => Promise<unknown>
		entry.handler = async (input: unknown, extra: unknown) => {
			const callId = newCallId()
			try {
				const result = (await original(input, extra)) as ToolResultLike | undefined
				const isErr = result?.isError === true
				logToolCall(name, callId, isErr ? "error" : "ok")
				return result
			} catch (err) {
				logToolCall(name, callId, "error", {
					error: err instanceof Error ? err.message : String(err),
				})
				throw err
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Concurrent initialize rejection (VAL-MCP-023)
// ---------------------------------------------------------------------------

function installInitializeGuard(server: McpServer): void {
	// The MCP SDK re-registers `InitializeRequestSchema` inside the
	// Server constructor. Replacing it here is supported by Protocol:
	// `setRequestHandler` overwrites the existing entry. The capabilities
	// come from the server's own `getCapabilities()` (public on the base
	// Protocol class — `Server`'s `getCapabilities` is a thin re-export);
	// the serverInfo is reconstructed from the same constants the
	// McpServer was built with.
	const capabilities = (server.server as unknown as { getCapabilities(): ServerCapabilities }).getCapabilities()
	server.server.setRequestHandler(InitializeRequestSchema, async (request: InitializeRequest) => {
		if (initState === "initialized") {
			throw new McpError(ErrorCode.InvalidRequest, "server already initialized")
		}
		initState = "initialized"
		const requestedVersion = request.params.protocolVersion
		const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
			? requestedVersion
			: LATEST_PROTOCOL_VERSION
		return {
			protocolVersion,
			capabilities,
			serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
		}
	})
	server.server.oninitialized = () => {
		// Stay "initialized" — subsequent initialize calls are rejected
		// by the guard above. The MCP spec permits this; the validation
		// contract (VAL-MCP-023) requires it.
	}
}

interface ServerCapabilities {
	[key: string]: unknown
}

let initState: "pending" | "initialized" = "pending"

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
