import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { engineRequest } from "@baka/engine"
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
import { OnExistingSchema, SlotsInputSchema as RunSlotsInputSchema } from "@repo/protocol"
import { z } from "zod"
import { createContext, type ServerContext } from "./context.js"
import { DESIGN_MODULE_DESCRIPTION, DESIGN_MODULE_PROMPT_NAME, designModuleMessages } from "./prompts/design-module.js"
import {
	listModulesResource,
	MODULE_MANIFEST_TEMPLATE_METADATA,
	MODULE_MANIFEST_URI_TEMPLATE_STRING,
	MODULES_RESOURCE_URI,
	readModuleManifestResource,
	readModulesResource,
} from "./resources/modules.js"
import {
	ApplyInputSchema,
	DesignModuleArgsShape,
	ListActionsInputSchema,
	PlanInputSchema,
	RegistryGetModuleInputSchema,
	RegistryGetPreviewInputSchema,
	RegistrySearchInputSchema,
	ValidateInputSchema,
} from "./schemas.js"
import { runRegistryGetModule, runRegistryGetPreview, runRegistrySearch } from "./tools/registry.js"
import { runApply, runPlan } from "./tools/workflow.js"

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

interface StartServerOptions {
	cwd: string
}

export function startServer(opts: StartServerOptions): McpServer {
	const ctx = createContext(opts.cwd)
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

	registerWorkflowTools(server, ctx)
	registerEngineTools(server, ctx)
	registerRegistryTools(server, ctx)
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
				"Plan a feature intent into a Zod-validated sequence of {module, action, params} steps. This tool does not modify the project tree; it only returns the resolved plan. To execute the plan, persist it with save:true and then call baka_apply, or call baka_<module>_<action> tools directly.",
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
				'Run all module validators (structural + module-level + action-level) against the current project tree. Returns { valid, modulesDiscovered, validation } with structured diagnostics. A failing validation (validation.kind === "fail") carries valid: false and the tool result is marked isError: true, so agent clients can branch on the failure without parsing free text.',
			inputSchema: ValidateInputSchema.shape,
		},
		async () => {
			const { status, json } = await engineRequest(ctx.cwd, "/v1/validate", {
				method: "POST",
				body: {},
				moduleDirs: ctx.moduleDirs,
			})
			const result = json as { valid?: boolean; error?: string }
			if (status >= 400) {
				return { ...jsonResult({ valid: false, error: result.error ?? "validate failed" }), isError: true }
			}
			return { ...jsonResult(json), ...(result.valid ? {} : { isError: true }) }
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
			const { status, json } = await engineRequest(ctx.cwd, "/v1/modules", { moduleDirs: ctx.moduleDirs })
			const body = json as {
				modules?: Array<{
					name: string
					version: string
					description: string
					actions: Array<{
						id: string
						description: string
						requiresReasoning: boolean
						compensatesWith?: string
						params: Array<{
							name: string
							type: string
							required: boolean
							description: string
							enumValues?: string[]
						}>
					}>
				}>
			}
			if (status >= 400) {
				throw new Error("failed to list modules")
			}
			const m = (body.modules ?? []).find((x) => x.name === input.module)
			if (!m) {
				const known = (body.modules ?? []).map((x) => x.name).join(", ")
				throw new Error(`module "${input.module}" not found. Discovered modules: ${known || "(none)"}`)
			}
			return jsonResult({
				module: m.name,
				version: m.version,
				description: m.description,
				actions: m.actions,
			})
		},
	)
}

// ---------------------------------------------------------------------------
// Slot-native engine tools (same handlers as `baka run|slots|fill --json`)
// ---------------------------------------------------------------------------

const RunInputSchema = z.object({
	module: z.string().min(1).describe("Module name"),
	action: z.string().min(1).describe("Action id"),
	params: z.record(z.unknown()).optional().describe("Action params"),
	slots: RunSlotsInputSchema.optional().describe(
		"Slot mode: live (cache, then model; default), record (always ask the model), or replay (only the supplied records; a missing slot is an error and no model call is made)",
	),
	onExisting: OnExistingSchema.optional().describe(
		"What to do with an existing template target: skip (default; identical content is reported unchanged, other content skip), overwrite (rewrite differing content), or fail (refuse the whole run, target-exists)",
	),
	dryRun: z.boolean().optional().describe("Compute the changeset and output tree hash without writing anything"),
	includeContent: z.boolean().optional().describe("Attach each written file's text to its changeset entry"),
})

const SlotsInputSchema = z.object({
	module: z.string().min(1).describe("Module name"),
	action: z.string().min(1).describe("Action id"),
})

const FillInputSchema = z.object({
	module: z.string().min(1).describe("Module name"),
	action: z.string().min(1).describe("Action id"),
	slot: z.string().min(1).describe("Slot id"),
	value: z.unknown().describe("Fill value"),
	params: z.record(z.unknown()).optional().describe("Action params (must match the later run)"),
})

function registerEngineTools(server: McpServer, ctx: ServerContext): void {
	server.registerTool(
		"baka_run",
		{
			description:
				"Materialize a named module/action. Templates are the output tree; the LLM fills named slots only. Returns the receipt: ok, diagnostics, changeset (path, op, contentHash), outputTreeHash, slots, compensation. Prefer `baka run <module>/<action> --json` in a shell. Same JSON as the CLI.",
			inputSchema: RunInputSchema.shape,
		},
		async (raw) => {
			const input = RunInputSchema.parse(raw)
			const { status, json } = await engineRequest(ctx.cwd, "/v1/run", {
				moduleDirs: ctx.moduleDirs,
				method: "POST",
				body: {
					module: input.module,
					action: input.action,
					params: input.params ?? {},
					slots: input.slots,
					onExisting: input.onExisting,
					dryRun: input.dryRun,
					includeContent: input.includeContent,
				},
			})
			const body = json as { ok?: boolean }
			return { ...jsonResult(json), ...(status >= 400 || body.ok === false ? { isError: true } : {}) }
		},
	)

	server.registerTool(
		"baka_slots",
		{
			description: "List named slots for a module/action. Same JSON as `baka slots <module>/<action> --json`.",
			inputSchema: SlotsInputSchema.shape,
		},
		async (raw) => {
			const input = SlotsInputSchema.parse(raw)
			const { status, json } = await engineRequest(
				ctx.cwd,
				`/v1/slots?module=${encodeURIComponent(input.module)}&action=${encodeURIComponent(input.action)}`,
				{ moduleDirs: ctx.moduleDirs },
			)
			return { ...jsonResult(json), ...(status >= 400 ? { isError: true } : {}) }
		},
	)

	server.registerTool(
		"baka_fill",
		{
			description: "Pin a slot fill in the project slot cache (model=manual). Same JSON as `baka fill --json`.",
			inputSchema: FillInputSchema.shape,
		},
		async (raw) => {
			const input = FillInputSchema.parse(raw)
			const { status, json } = await engineRequest(ctx.cwd, "/v1/fill", {
				moduleDirs: ctx.moduleDirs,
				method: "POST",
				body: {
					module: input.module,
					action: input.action,
					slot: input.slot,
					value: input.value,
					params: input.params ?? {},
				},
			})
			return { ...jsonResult(json), ...(status >= 400 ? { isError: true } : {}) }
		},
	)
}

// ---------------------------------------------------------------------------
// Registry discovery tools (milestone 5 mcp-registry-tools; VAL-DISC-024
// / 025 / 026 / 027 / 028 / 029 / 044 / 045).
//
// Read-only discovery surface for a baka module registry. Three tools:
//   - baka_registry_search       -> GET /v1/modules (per-source filtered)
//   - baka_registry_get_module  -> GET /v1/modules/<scope>/<name>
//                                   + .../<latestVersion> (combined detail)
//   - baka_registry_get_preview -> GET .../previews + .../previews/<actionId>
//
// Architecture §8 decision 9: there is NO install capability over MCP.
// Tool descriptions explicitly say so and name the CLI handoff
// (`baka install @scope/name`); the README documents the same.
//
// Per-source failure isolation (architecture §8 decision 27): a
// transport failure on one configured registry does NOT abort the
// search — it surfaces as a per-source `warnings[]` entry. Only
// when EVERY source is unreachable does the tool return
// `isError: true` (VAL-DISC-028). The contract distinguishes "registry
// down" from "no rows match" cleanly so agent clients branch on a
// boolean, not on free text.
// ---------------------------------------------------------------------------

function registerRegistryTools(server: McpServer, ctx: ServerContext): void {
	server.registerTool(
		"baka_registry_search",
		{
			description:
				"Search modules across every configured baka registry (BAKA_REGISTRY_URL env > .baka/settings.json registries list > default http://localhost:4300). Returns structured hits (scope, name, tier, visibility, description, version, registry) with per-source attribution and per-source failure warnings. Does NOT modify the project. To install a discovered module, run `baka install @<scope>/<name>` at the terminal (the MCP has no install capability, by design).",
			inputSchema: RegistrySearchInputSchema.shape,
		},
		async (raw) => {
			const input = RegistrySearchInputSchema.parse(raw)
			const result = await runRegistrySearch(ctx.cwd, input)
			if (!result.ok) {
				return { ...jsonResult(result.payload), isError: true }
			}
			return jsonResult(result.payload)
		},
	)

	server.registerTool(
		"baka_registry_get_module",
		{
			description:
				"Read a module's served manifest, versions list, tier badge, and screening verdict from the baka registry (mirrors `baka registry info @<scope>/<name>`). Does NOT modify the project. Structured result: scope, name, tier, visibility, description, latestVersion, versions[], manifest, screening. An unknown module returns isError:true naming the missing module. To install: `baka install @<scope>/<name>` at the terminal.",
			inputSchema: RegistryGetModuleInputSchema.shape,
		},
		async (raw) => {
			const input = RegistryGetModuleInputSchema.parse(raw)
			const result = await runRegistryGetModule(ctx.cwd, input)
			if (!result.ok) {
				return { ...jsonResult(result.payload), isError: true }
			}
			return jsonResult(result.payload)
		},
	)

	server.registerTool(
		"baka_registry_get_preview",
		{
			description:
				"Read the generated-code preview per action for a registry module version (mirrors `baka registry preview @<scope>/<name>[@<version>]`). Non-reasoning actions return rendered file CONTENTS; reasoning actions return an explicit `needs-llm` marker (NEVER fabricated code). Does NOT modify the project. An unknown module or version returns isError:true. To install and execute: `baka install @<scope>/<name>` at the terminal.",
			inputSchema: RegistryGetPreviewInputSchema.shape,
		},
		async (raw) => {
			const input = RegistryGetPreviewInputSchema.parse(raw)
			const result = await runRegistryGetPreview(ctx.cwd, input)
			if (!result.ok) {
				return { ...jsonResult(result.payload), isError: true }
			}
			return jsonResult(result.payload)
		},
	)
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
