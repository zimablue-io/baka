import { createHash, timingSafeEqual } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { createLLMProvider, loadLLMConfig, validateLLMConfig } from "@repo/agent-engine"
import {
	canonicalJson,
	createDiskSlotStore,
	describeModules,
	hashBytes,
	listActionSlots,
	ModuleNotFoundError,
	ModuleRegistry,
	parseActionTemplates,
	previewAction,
	readLockfile,
	resolveAction,
	runAction,
	slotCacheKey,
	validateProject,
	writeSlotCache,
} from "@repo/ast-tooling"
import {
	BAKA_DEFAULT_WORKER_MODEL,
	BAKA_EXIT_CODE,
	type LLMProvider,
	OnExistingSchema,
	SlotsInputSchema,
} from "@repo/protocol"
import { type Context, Hono } from "hono"
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
	/** The project this engine is bound to; the default for every request. */
	cwd: string
	/**
	 * Require `Authorization: Bearer <token>` on every request. Unset means no
	 * authentication, which `serveEngine` only permits on a loopback bind.
	 */
	token?: string
	/**
	 * Directories a request's `project` may point into (the directory itself or
	 * anything below it). Empty or unset: a request may only name `cwd` itself.
	 */
	allowedRoots?: readonly string[]
}

const RunBodySchema = z.object({
	module: z.string().min(1),
	action: z.string().min(1),
	params: z.record(z.unknown()).default({}),
	dryRun: z.boolean().optional(),
	slots: SlotsInputSchema.optional(),
	onExisting: OnExistingSchema.optional(),
	validate: z.boolean().optional(),
	includeContent: z.boolean().optional(),
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

/** A request the engine refuses before running anything; `status` is the HTTP status to answer with. */
class RequestError extends Error {
	constructor(
		readonly status: 400 | 403,
		message: string,
	) {
		super(message)
		this.name = "RequestError"
	}
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Pick the project a request runs against. With no `project` it is the
 * engine's own `cwd`. A caller-supplied `project` must be an absolute path to
 * an existing directory, and after resolving symlinks it must be `cwd` itself
 * or sit inside one of the configured allowed roots; otherwise the request is
 * refused (403). With no allowed roots configured, only `cwd` itself passes, so
 * a caller can never steer the engine to read or write an arbitrary directory.
 */
function resolveProject(defaultCwd: string, raw: string | undefined, allowedRoots: readonly string[]): string {
	if (!raw || raw.trim() === "") return defaultCwd
	if (!isAbsolute(raw)) throw new RequestError(400, "project must be an absolute path")
	if (!existsSync(raw)) throw new RequestError(400, `project does not exist: ${raw}`)
	const real = realpathSync(raw)
	if (real === realpathSync(defaultCwd)) return real
	if (allowedRoots.length === 0) {
		throw new RequestError(
			403,
			"project paths are disabled: start the engine with an allowed root (baka serve --allow-root <dir>) to run against other directories",
		)
	}
	if (!allowedRoots.some((root) => isInside(root, real))) {
		throw new RequestError(403, "project is outside the allowed roots")
	}
	return real
}

/** The JSON error response for a thrown error: a refused request keeps its own status, anything else gets `fallback`. */
function failure(c: Context, err: unknown, fallback: 400 | 404): Response {
	if (err instanceof RequestError) return c.json({ error: err.message }, err.status)
	return c.json({ error: err instanceof Error ? err.message : String(err) }, fallback)
}

async function readBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json()
	} catch {
		throw new RequestError(400, "request body must be JSON")
	}
}

function bearerMatches(expected: Buffer, header: string | undefined): boolean {
	const presented = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "")?.[1]
	if (presented === undefined) return false
	// Hash both sides so the comparison is constant-time whatever the lengths.
	return timingSafeEqual(createHash("sha256").update(presented).digest(), expected)
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

export function createEngineApp(opts: EngineAppOptions): Hono {
	const app = new Hono()
	const cwd = opts.cwd
	// Resolved once so a symlinked root cannot be swapped for another target later.
	const allowedRoots = (opts.allowedRoots ?? []).map((root) => realpathSync(root))
	const projectOf = (raw: string | undefined): string => resolveProject(cwd, raw, allowedRoots)

	app.use(
		"*",
		cors({
			origin: localBrowserOrigin,
		}),
	)

	if (opts.token) {
		const expected = createHash("sha256").update(opts.token).digest()
		app.use("*", async (c, next) => {
			// CORS preflights carry no credentials; the cors middleware above answers them.
			if (c.req.method === "OPTIONS" || bearerMatches(expected, c.req.header("authorization"))) return next()
			return c.json({ error: "unauthorized: send Authorization: Bearer <token>" }, 401, {
				"WWW-Authenticate": "Bearer",
			})
		})
	}

	app.get("/v1/modules", (c) => {
		let project: string
		try {
			project = projectOf(c.req.query("project"))
		} catch (err) {
			return failure(c, err, 400)
		}
		return c.json(describeModules(new ModuleRegistry(project)))
	})

	app.get("/v1/slots", (c) => {
		const moduleName = c.req.query("module")
		const actionId = c.req.query("action")
		if (!moduleName || !actionId) {
			return c.json({ error: "module and action query params are required" }, 400)
		}
		try {
			const project = projectOf(c.req.query("project"))
			const listed = listActionSlots(new ModuleRegistry(project), moduleName, actionId)
			return c.json(listed)
		} catch (err) {
			return failure(c, err, 404)
		}
	})

	app.get("/v1/preview", (c) => {
		const moduleName = c.req.query("module")
		const actionId = c.req.query("action")
		if (!moduleName || !actionId) {
			return c.json({ error: "module and action query params are required" }, 400)
		}
		try {
			const project = projectOf(c.req.query("project"))
			return c.json(previewAction(new ModuleRegistry(project), moduleName, actionId))
		} catch (err) {
			return failure(c, err, 404)
		}
	})

	app.post("/v1/run", async (c) => {
		let raw: unknown
		try {
			raw = await readBody(c)
		} catch (err) {
			return failure(c, err, 400)
		}
		const parsed = RunBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json({ error: parsed.error.message, code: BAKA_EXIT_CODE.USER_ERROR }, 400)
		}
		let project: string
		try {
			project = projectOf(parsed.data.project)
		} catch (err) {
			return failure(c, err, 400)
		}
		let lock: ReturnType<typeof readLockfile>
		try {
			// A project that has a baka.lock.json is held to it on every run.
			lock = readLockfile(project)
		} catch (err) {
			return failure(c, err, 400)
		}
		const { provider, model } = await resolveWorker(project)
		const result = await runAction({
			registry: new ModuleRegistry(project),
			lock: lock ?? undefined,
			store: createDiskSlotStore(project, { userFallback: true }),
			module: parsed.data.module,
			action: parsed.data.action,
			params: parsed.data.params,
			provider,
			model,
			dryRun: parsed.data.dryRun,
			slots: parsed.data.slots,
			onExisting: parsed.data.onExisting,
			includeContent: parsed.data.includeContent,
			validate: parsed.data.validate,
		})
		const status = result.ok ? 200 : 400
		return c.json(result, status)
	})

	app.post("/v1/fill", async (c) => {
		let raw: unknown
		try {
			raw = await readBody(c)
		} catch (err) {
			return failure(c, err, 400)
		}
		const parsed = FillBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json({ error: parsed.error.message, code: BAKA_EXIT_CODE.USER_ERROR }, 400)
		}
		try {
			const project = projectOf(parsed.data.project)
			const { moduleRoot, action } = resolveAction(new ModuleRegistry(project), parsed.data.module, parsed.data.action)
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
			return failure(c, err, 400)
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
			project = projectOf(body.project)
		} catch (err) {
			return failure(c, err, 400)
		}
		try {
			return c.json(await validateProject(new ModuleRegistry(project), body.module))
		} catch (err) {
			if (err instanceof ModuleNotFoundError) {
				return c.json({ error: err.message, code: BAKA_EXIT_CODE.USER_ERROR }, 400)
			}
			throw err
		}
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
