import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { createLLMProvider, loadLLMConfig, validateLLMConfig } from "@repo/agent-engine"
import {
	canonicalJson,
	hashBytes,
	listActionSlots,
	ModuleRegistry,
	parseActionTemplates,
	previewAction,
	resolveAction,
	runNamedAction,
	runValidators,
	slotCacheKey,
	writeSlotCache,
} from "@repo/ast-tooling"
import {
	BAKA_DEFAULT_WORKER_MODEL,
	BAKA_EXIT_CODE,
	ENGINE_STATUS,
	type LLMProvider,
	type OrchestrationState,
} from "@repo/protocol"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { z } from "zod"

function localBrowserOrigin(origin: string): string | undefined {
	try {
		const host = new URL(origin).hostname
		if (host === "localhost" || host === "127.0.0.1") return origin
	} catch {
		return undefined
	}
	return undefined
}

export interface EngineAppOptions {
	cwd: string
}

const RunBodySchema = z.object({
	module: z.string().min(1),
	action: z.string().min(1),
	params: z.record(z.unknown()).default({}),
	refill: z.boolean().optional(),
	project: z.string().optional(),
})

const FillBodySchema = z.object({
	module: z.string().min(1),
	action: z.string().min(1),
	slot: z.string().min(1),
	value: z.unknown(),
	params: z.record(z.unknown()).default({}),
	project: z.string().optional(),
})

const ValidateBodySchema = z.object({
	module: z.string().optional(),
	project: z.string().optional(),
})

function resolveProject(defaultCwd: string, raw: string | undefined): string {
	if (!raw || raw.trim() === "") return defaultCwd
	if (!isAbsolute(raw)) {
		throw new Error("project must be an absolute path")
	}
	if (!existsSync(raw)) {
		throw new Error(`project does not exist: ${raw}`)
	}
	return raw
}

async function resolveWorker(cwd: string): Promise<{ provider: LLMProvider | null; model: string }> {
	try {
		const config = await loadLLMConfig({ role: "worker", cwd })
		validateLLMConfig(config)
		return { provider: createLLMProvider(config), model: config.model }
	} catch {
		return { provider: null, model: BAKA_DEFAULT_WORKER_MODEL }
	}
}

function emptyState(cwd: string): OrchestrationState {
	return {
		userIntent: "",
		targetDirectory: cwd,
		status: ENGINE_STATUS.VALIDATING,
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
}

export function createEngineApp(opts: EngineAppOptions): Hono {
	const app = new Hono()
	const cwd = opts.cwd

	app.use(
		"*",
		cors({
			origin: localBrowserOrigin,
		}),
	)

	app.get("/v1/modules", (c) => {
		let project: string
		try {
			project = resolveProject(cwd, c.req.query("project"))
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
		const registry = new ModuleRegistry(project)
		const { modules, diagnostics } = registry.discover(false)
		return c.json({
			modules: modules.map((m) => ({
				name: m.name,
				version: m.version,
				description: m.description,
				actions: m.actions.map((a) => ({
					id: a.id,
					description: a.description,
					params: a.params,
					requiresReasoning: a.requiresReasoning,
					filePatterns: a.filePatterns,
					compensatesWith: a.compensatesWith,
				})),
			})),
			diagnostics,
		})
	})

	app.get("/v1/slots", (c) => {
		const moduleName = c.req.query("module")
		const actionId = c.req.query("action")
		if (!moduleName || !actionId) {
			return c.json({ error: "module and action query params are required" }, 400)
		}
		try {
			const project = resolveProject(cwd, c.req.query("project"))
			const listed = listActionSlots(project, moduleName, actionId)
			return c.json(listed)
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
		}
	})

	app.get("/v1/preview", (c) => {
		const moduleName = c.req.query("module")
		const actionId = c.req.query("action")
		if (!moduleName || !actionId) {
			return c.json({ error: "module and action query params are required" }, 400)
		}
		try {
			const project = resolveProject(cwd, c.req.query("project"))
			return c.json(previewAction(project, moduleName, actionId))
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
		}
	})

	app.post("/v1/run", async (c) => {
		const parsed = RunBodySchema.safeParse(await c.req.json())
		if (!parsed.success) {
			return c.json({ error: parsed.error.message, code: BAKA_EXIT_CODE.USER_ERROR }, 400)
		}
		let project: string
		try {
			project = resolveProject(cwd, parsed.data.project)
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
		const { provider, model } = await resolveWorker(project)
		const result = await runNamedAction({
			cwd: project,
			module: parsed.data.module,
			action: parsed.data.action,
			params: parsed.data.params,
			provider,
			model,
			refill: parsed.data.refill,
			validate: false,
		})
		const status = result.ok ? 200 : 400
		return c.json(result, status)
	})

	app.post("/v1/fill", async (c) => {
		const parsed = FillBodySchema.safeParse(await c.req.json())
		if (!parsed.success) {
			return c.json({ error: parsed.error.message, code: BAKA_EXIT_CODE.USER_ERROR }, 400)
		}
		try {
			const project = resolveProject(cwd, parsed.data.project)
			const { moduleRoot, action } = resolveAction(project, parsed.data.module, parsed.data.action)
			const templatesDir = join(moduleRoot, action.id, "templates")
			if (!existsSync(templatesDir)) {
				return c.json({ error: `action "${action.id}" has no templates/` }, 400)
			}
			const { files, slots } = parseActionTemplates(templatesDir)
			const slot = slots.find((s) => s.id === parsed.data.slot)
			if (!slot) {
				return c.json({ error: `slot "${parsed.data.slot}" not found` }, 404)
			}
			const template = files.find((f) => f.rel === slot.file)
			if (!template) {
				return c.json({ error: `template for slot "${slot.id}" missing` }, 500)
			}
			const model = "manual"
			const key = slotCacheKey({
				templateHash: hashBytes(template.source),
				slotId: slot.id,
				paramsHash: hashBytes(canonicalJson(parsed.data.params)),
				model,
			})
			const path = writeSlotCache(project, {
				key,
				slotId: slot.id,
				kind: slot.kind,
				value: parsed.data.value,
				model,
				templateHash: hashBytes(template.source),
				paramsHash: hashBytes(canonicalJson(parsed.data.params)),
			})
			return c.json({ ok: true, slot: slot.id, cachePath: path, key })
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
	})

	app.post("/v1/validate", async (c) => {
		let body: z.infer<typeof ValidateBodySchema> = {}
		try {
			const raw = await c.req.json()
			const parsed = ValidateBodySchema.safeParse(raw)
			if (!parsed.success) {
				return c.json({ error: parsed.error.message }, 400)
			}
			body = parsed.data
		} catch {
			body = {}
		}
		let project: string
		try {
			project = resolveProject(cwd, body.project)
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
		const registry = new ModuleRegistry(project)
		const { modules } = registry.discover(false)
		if (body.module && !modules.some((m) => m.name === body.module)) {
			return c.json({ error: `module "${body.module}" not found`, code: BAKA_EXIT_CODE.USER_ERROR }, 400)
		}
		const result = await runValidators(project, emptyState(project), undefined, body.module)
		return c.json({
			valid: result.kind !== "fail",
			modulesDiscovered: modules.length,
			validation: result,
			moduleName: body.module,
		})
	})

	app.all("/mcp", (c) => {
		return c.json(
			{
				error: "stdio MCP is baka-mcp; JSON tools are /v1/*. Hosts without a shell spawn baka-mcp.",
			},
			501,
		)
	})

	return app
}

export async function engineRequest(
	cwd: string,
	path: string,
	init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
	const app = createEngineApp({ cwd })
	const res = await app.request(path, {
		method: init?.method ?? "GET",
		headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
		body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
	})
	return { status: res.status, json: await res.json() }
}
