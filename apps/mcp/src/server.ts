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
import { type BakaAddon, OnExistingSchema, SlotsInputSchema as RunSlotsInputSchema } from "@repo/protocol"
import { z } from "zod"
import { createContext, engineOptions, type ServerContext } from "./context.js"
import { DESIGN_PACK_DESCRIPTION, DESIGN_PACK_PROMPT_NAME, designPackMessages } from "./prompts/design-pack.js"
import {
	listPacksResource,
	PACK_MANIFEST_TEMPLATE_METADATA,
	PACK_MANIFEST_URI_TEMPLATE_STRING,
	PACKS_RESOURCE_URI,
	readPackManifestResource,
	readPacksResource,
} from "./resources/packs.js"
import {
	ApplyInputSchema,
	DesignPackArgsShape,
	ListRecipesInputSchema,
	PlanInputSchema,
	RegistryGetPackInputSchema,
	RegistryGetPreviewInputSchema,
	RegistrySearchInputSchema,
	ValidateInputSchema,
} from "./schemas.js"
import { runRegistryGetPack, runRegistryGetPreview, runRegistrySearch } from "./tools/registry.js"
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
	/** Add-ons the host launched this server with (`BAKA_ADDONS`), already loaded. */
	addons?: BakaAddon[]
}

export function startServer(opts: StartServerOptions): McpServer {
	const ctx = createContext(opts.cwd, opts.addons)
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
				"Plan a feature intent into a Zod-validated sequence of {pack, recipe, params} steps. This tool does not modify the project tree; it only returns the resolved plan. To execute the plan, persist it with save:true and then call baka_apply, or call baka_<pack>_<recipe> tools directly.",
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
				"Apply a saved plan file. Loads the plan, runs the SAGA with SAGA compensation, and runs all pack validators. Returns the per-step status, failure (if any), and validator diagnostics.",
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
				'Run all pack validators (structural + pack-level + recipe-level) against the current project tree. Returns { valid, packsDiscovered, validation } with structured diagnostics. A failing validation (validation.kind === "fail") carries valid: false and the tool result is marked isError: true, so agent clients can branch on the failure without parsing free text.',
			inputSchema: ValidateInputSchema.shape,
		},
		async () => {
			const { status, json } = await engineRequest(ctx.cwd, "/v1/validate", {
				method: "POST",
				body: {},
				...engineOptions(ctx),
			})
			const result = json as { valid?: boolean }
			if (status >= 400) {
				return { ...jsonResult({ valid: false, ...(json as object) }), isError: true }
			}
			return { ...jsonResult(json), ...(result.valid ? {} : { isError: true }) }
		},
	)

	server.registerTool(
		"baka_list_recipes",
		{
			description:
				"List the recipes declared by a pack, including each recipe's params, validators, and compensation pointer. The finite, declared set of recipes baka constrains the LLM to is exactly this list.",
			inputSchema: ListRecipesInputSchema.shape,
		},
		async (raw) => {
			const input = ListRecipesInputSchema.parse(raw)
			const { status, json } = await engineRequest(ctx.cwd, "/v1/packs", engineOptions(ctx))
			const body = json as {
				packs?: Array<{
					name: string
					version: string
					description: string
					recipes: Array<{
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
				throw new Error("failed to list packs")
			}
			const m = (body.packs ?? []).find((x) => x.name === input.pack)
			if (!m) {
				const known = (body.packs ?? []).map((x) => x.name).join(", ")
				throw new Error(`pack "${input.pack}" not found. Discovered packs: ${known || "(none)"}`)
			}
			return jsonResult({
				pack: m.name,
				version: m.version,
				description: m.description,
				recipes: m.recipes,
			})
		},
	)
}

// ---------------------------------------------------------------------------
// Slot-native engine tools (same handlers as `baka run|slots|fill --json`)
// ---------------------------------------------------------------------------

const RunInputSchema = z.object({
	pack: z.string().min(1).optional().describe("Pack name; omit it when only one pack declares the recipe"),
	recipe: z.string().min(1).describe("Recipe id"),
	params: z.record(z.unknown()).optional().describe("Recipe params"),
	slots: RunSlotsInputSchema.optional().describe(
		"Slot mode: live (cache, then model; default), record (always ask the model), or replay (only the supplied records; a missing slot is an error and no model call is made)",
	),
	onExisting: OnExistingSchema.optional().describe(
		"What to do with an existing template target: skip (default; identical content is reported unchanged, other content skip), overwrite (rewrite differing content), or fail (refuse the whole run, target-exists)",
	),
	dryRun: z.boolean().optional().describe("Compute the changeset and output tree hash without writing anything"),
	includeContent: z.boolean().optional().describe("Attach each written file's text to its changeset entry"),
	format: z.boolean().optional().describe("Run the formatter the recipe declares over the files the run wrote"),
})

const SlotsInputSchema = z.object({
	pack: z.string().min(1).optional().describe("Pack name; omit it when only one pack declares the recipe"),
	recipe: z.string().min(1).describe("Recipe id"),
})

const FillInputSchema = z.object({
	pack: z.string().min(1).optional().describe("Pack name; omit it when only one pack declares the recipe"),
	recipe: z.string().min(1).describe("Recipe id"),
	slot: z.string().min(1).describe("Slot id"),
	value: z.unknown().describe("Fill value"),
	params: z.record(z.unknown()).optional().describe("Recipe params (must match the later run)"),
})

function registerEngineTools(server: McpServer, ctx: ServerContext): void {
	server.registerTool(
		"baka_run",
		{
			description:
				"Run a recipe. Templates are the output tree; named slots are filled from slots.values (you supply them, no model needed), the cache, or a model if the host configured one. Slots that are still open come back in the receipt as openSlots. Returns the receipt: ok, diagnostics, changeset (path, op, contentHash), outputTreeHash, slots, compensation. Same JSON as `baka run <recipe> --json`.",
			inputSchema: RunInputSchema.shape,
		},
		async (raw) => {
			const input = RunInputSchema.parse(raw)
			const { status, json } = await engineRequest(ctx.cwd, "/v1/run", {
				...engineOptions(ctx),
				method: "POST",
				body: {
					pack: input.pack,
					recipe: input.recipe,
					params: input.params ?? {},
					slots: input.slots,
					onExisting: input.onExisting,
					dryRun: input.dryRun,
					includeContent: input.includeContent,
					format: input.format,
				},
			})
			const body = json as { ok?: boolean }
			return { ...jsonResult(json), ...(status >= 400 || body.ok === false ? { isError: true } : {}) }
		},
	)

	server.registerTool(
		"baka_slots",
		{
			description: "List named slots for a pack/recipe. Same JSON as `baka slots <pack>/<recipe> --json`.",
			inputSchema: SlotsInputSchema.shape,
		},
		async (raw) => {
			const input = SlotsInputSchema.parse(raw)
			const { status, json } = await engineRequest(
				ctx.cwd,
				`/v1/slots?${input.pack ? `pack=${encodeURIComponent(input.pack)}&` : ""}recipe=${encodeURIComponent(input.recipe)}`,
				engineOptions(ctx),
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
				...engineOptions(ctx),
				method: "POST",
				body: {
					pack: input.pack,
					recipe: input.recipe,
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
// Read-only discovery surface for a baka pack registry. Three tools:
//   - baka_registry_search       -> GET /v1/packs (per-source filtered)
//   - baka_registry_get_pack  -> GET /v1/packs/<scope>/<name>
//                                   + .../<latestVersion> (combined detail)
//   - baka_registry_get_preview -> GET .../previews + .../previews/<recipeId>
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
				"Search packs across every configured baka registry (BAKA_REGISTRY_URL env > .baka/settings.json registries list > default http://localhost:4300). Returns structured hits (scope, name, tier, visibility, description, version, registry) with per-source attribution and per-source failure warnings. Does NOT modify the project. To install a discovered pack, run `baka install @<scope>/<name>` at the terminal (the MCP has no install capability, by design).",
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
		"baka_registry_get_pack",
		{
			description:
				"Read a pack's served manifest, versions list, tier badge, and screening verdict from the baka registry (mirrors `baka registry info @<scope>/<name>`). Does NOT modify the project. Structured result: scope, name, tier, visibility, description, latestVersion, versions[], manifest, screening. An unknown pack returns isError:true naming the missing pack. To install: `baka install @<scope>/<name>` at the terminal.",
			inputSchema: RegistryGetPackInputSchema.shape,
		},
		async (raw) => {
			const input = RegistryGetPackInputSchema.parse(raw)
			const result = await runRegistryGetPack(ctx.cwd, input)
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
				"Read the generated-code preview per recipe for a registry pack version (mirrors `baka registry preview @<scope>/<name>[@<version>]`). Non-reasoning recipes return rendered file CONTENTS; reasoning recipes return an explicit `needs-llm` marker (NEVER fabricated code). Does NOT modify the project. An unknown pack or version returns isError:true. To install and execute: `baka install @<scope>/<name>` at the terminal.",
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
	// baka://packs — directory of all packs
	server.registerResource(
		"baka-packs",
		PACKS_RESOURCE_URI,
		{
			description: listPacksResource(ctx).description,
			mimeType: "application/json",
		},
		async (uri): Promise<ReadResourceResult> => {
			void uri
			return readPacksResource(ctx)
		},
	)

	// baka://pack/{name}/manifest — full manifest for one pack
	server.registerResource(
		"baka-pack-manifest",
		new ResourceTemplate(PACK_MANIFEST_URI_TEMPLATE_STRING, { list: undefined }),
		{
			description: PACK_MANIFEST_TEMPLATE_METADATA.description,
			mimeType: PACK_MANIFEST_TEMPLATE_METADATA.mimeType,
		},
		async (uri): Promise<ReadResourceResult> => readPackManifestResource(ctx, uri.href),
	)
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function registerPrompts(server: McpServer): void {
	server.registerPrompt(
		DESIGN_PACK_PROMPT_NAME,
		{
			description: DESIGN_PACK_DESCRIPTION,
			argsSchema: DesignPackArgsShape,
		},
		(args) => {
			const parsed = z
				.object({
					name: DesignPackArgsShape.name,
					resume: DesignPackArgsShape.resume,
				})
				.parse(args)
			return {
				messages: designPackMessages(parsed),
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
