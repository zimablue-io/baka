import { createHash, timingSafeEqual } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { createLLMProvider, LlmCallError, resolveCallLLM } from "@repo/agent-engine"
import {
	canonicalJson,
	createDiskSlotStore,
	describePacks,
	findRecipePack,
	hashBytes,
	listRecipeSlots,
	PackDirsError,
	PackNotFoundError,
	PackRegistry,
	packDirsFromSettings,
	parseRecipeTemplates,
	previewRecipe,
	RecipeError,
	readLockfile,
	resolveRecipe,
	runRecipe,
	slotCacheKey,
	validateProject,
	writeSlotCache,
} from "@repo/ast-tooling"
import {
	BAKA_DEFAULT_WORKER_MODEL,
	type BakaAddon,
	type LLMProvider,
	type LlmCall,
	LlmCallSchema,
	normalizeParams,
	OnExistingSchema,
	SlotsInputSchema,
} from "@repo/protocol"
import { type Context, Hono } from "hono"
import { cors } from "hono/cors"
import { z } from "zod"

function isLocalBrowserOrigin(origin: string): boolean {
	try {
		const host = new URL(origin).hostname
		return host === "localhost" || host === "127.0.0.1"
	} catch {
		return false
	}
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
	/**
	 * Directories packs are drawn from, highest precedence first (relative
	 * paths resolve against the project). When set, ONLY these are searched:
	 * the project's `packs/`, `.baka/packs`, and the user marketplace are
	 * not, so a catalog elsewhere can serve any project without symlinks and
	 * without being written to. Unset: each project's `.baka/settings.json`
	 * `packDirs`, else the default discovery.
	 */
	packDirs?: readonly string[]
	/**
	 * Read nothing from the machine's user directory (`${BAKA_HOME:-$HOME/.baka}`): no user packs,
	 * no user slot cache, no stored model. What a call does is then decided only by what the
	 * engine was started with, the project, and the request.
	 */
	isolated?: boolean
	/** The model used when a request names none and (unless isolated) the user's config has none. */
	llm?: LlmCall
	/**
	 * Origins of web pages, besides this machine's own, that may call the engine from a browser
	 * (exact matches such as `https://baka.dashboard.zimablue.io`). `serveEngine` only accepts
	 * them together with a bearer token.
	 */
	allowedOrigins?: readonly string[]
	/** Packs that ship with the installed tool; searched after every other default scope. */
	bundledPacksDir?: string
	/** Add-ons attached to every run this engine serves (see `BakaAddon`). */
	addons?: readonly BakaAddon[]
}

const RunBodySchema = z.object({
	pack: z.string().min(1).optional(),
	recipe: z.string().min(1),
	llm: LlmCallSchema.optional(),
	params: z.record(z.unknown()).default({}),
	dryRun: z.boolean().optional(),
	slots: SlotsInputSchema.optional(),
	onExisting: OnExistingSchema.optional(),
	validate: z.boolean().optional(),
	includeContent: z.boolean().optional(),
	format: z.boolean().optional(),
	project: z.string().optional(),
})

const FillBodySchema = z.object({
	pack: z.string().min(1).optional(),
	recipe: z.string().min(1),
	slot: z.string().min(1),
	value: z.unknown(),
	params: z.record(z.unknown()).default({}),
	project: z.string().optional(),
})

const ValidateBodySchema = z.object({
	pack: z.string().optional(),
	project: z.string().optional(),
})

/** A request the engine refuses before running anything; `status` is the HTTP status to answer with. */
class RequestError extends Error {
	constructor(
		readonly status: 400 | 403,
		message: string,
		readonly code: string = "bad-request",
		readonly hint?: string,
	) {
		super(message)
		this.name = "RequestError"
	}
}

/** The one error shape: `{ error: { code, message, hint? } }`. A run's own failure is its receipt instead. */
function apiError(c: Context, status: 400 | 401 | 403 | 404 | 500 | 501, code: string, message: string, hint?: string) {
	return c.json({ error: { code, message, ...(hint ? { hint } : {}) } }, status)
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
			"forbidden",
		)
	}
	if (!allowedRoots.some((root) => isInside(root, real))) {
		throw new RequestError(403, "project is outside the allowed roots", "forbidden")
	}
	return real
}

/** The JSON error response for a thrown error: a refused request keeps its own status, a bad pack-directory setting is 400, anything else gets `fallback`. */
function failure(c: Context, err: unknown, fallback: 400 | 404): Response {
	if (err instanceof RequestError) return apiError(c, err.status, err.code, err.message, err.hint)
	if (err instanceof PackDirsError) {
		return apiError(
			c,
			400,
			"pack-dirs-invalid",
			err.message,
			"Fix or remove the packDirs entry in .baka/settings.json.",
		)
	}
	if (err instanceof RecipeError) return apiError(c, fallback, err.code, err.message)
	if (err instanceof LlmCallError) return apiError(c, 400, "bad-request", err.message)
	const code = fallback === 404 ? "not-found" : "bad-request"
	return apiError(c, fallback, code, err instanceof Error ? err.message : String(err))
}

async function readBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json()
	} catch {
		throw new RequestError(400, "request body must be JSON")
	}
}

function badBody(c: Context, error: z.ZodError): Response {
	return apiError(c, 400, "bad-request", error.message, "See the request schema for this route.")
}

function bearerMatches(expected: Buffer, header: string | undefined): boolean {
	const presented = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "")?.[1]
	if (presented === undefined) return false
	// Hash both sides so the comparison is constant-time whatever the lengths.
	return timingSafeEqual(createHash("sha256").update(presented).digest(), expected)
}

export function createEngineApp(opts: EngineAppOptions): Hono {
	const app = new Hono()
	const cwd = opts.cwd
	const isolated = opts.isolated === true
	const allowedOrigins = new Set(opts.allowedOrigins ?? [])
	// Resolved once so a symlinked root cannot be swapped for another target later.
	const allowedRoots = (opts.allowedRoots ?? []).map((root) => realpathSync(root))
	const projectOf = (raw: string | undefined): string => resolveProject(cwd, raw, allowedRoots)
	// Directories the engine was started with decide for every project; without them each project's own
	// `.baka/settings.json` `packDirs` does, and without those the default discovery.
	const registryOf = (project: string): PackRegistry =>
		new PackRegistry(project, {
			packDirs: opts.packDirs ?? packDirsFromSettings(project),
			userScope: !isolated,
			bundledDir: opts.bundledPacksDir,
		})
	/** The pack a request means: the one it names, else the single pack that declares the recipe. */
	const packOf = (registry: PackRegistry, pack: string | undefined, recipe: string): string =>
		pack ?? findRecipePack(registry, recipe)
	/** The worker model for one call; null means none is available, which a run reports as open slots. */
	const workerFor = async (
		project: string,
		call: LlmCall | undefined,
	): Promise<{ provider: LLMProvider | null; model: string }> => {
		const config = await resolveCallLLM({ call: { ...opts.llm, ...call }, cwd: project, isolated })
		return config
			? { provider: createLLMProvider(config), model: config.model }
			: { provider: null, model: BAKA_DEFAULT_WORKER_MODEL }
	}

	app.onError((err, c) => {
		if (err instanceof PackDirsError) return failure(c, err, 400)
		console.error(err)
		return apiError(c, 500, "internal", "Internal Server Error")
	})

	const originAllowed = (origin: string): boolean => isLocalBrowserOrigin(origin) || allowedOrigins.has(origin)
	// A public page may call a loopback engine only if the browser's Private Network Access preflight
	// is answered; it is, and only for an origin that is allowed.
	app.use("*", async (c, next) => {
		await next()
		const origin = c.req.header("origin")
		if (origin && c.req.header("access-control-request-private-network") === "true" && originAllowed(origin)) {
			c.res.headers.set("Access-Control-Allow-Private-Network", "true")
		}
	})
	app.use("*", cors({ origin: (origin) => (originAllowed(origin) ? origin : undefined) }))

	if (opts.token) {
		const expected = createHash("sha256").update(opts.token).digest()
		app.use("*", async (c, next) => {
			// CORS preflights carry no credentials; the cors middleware above answers them.
			if (c.req.method === "OPTIONS" || bearerMatches(expected, c.req.header("authorization"))) return next()
			c.header("WWW-Authenticate", "Bearer")
			return apiError(c, 401, "unauthorized", "unauthorized: send Authorization: Bearer <token>")
		})
	}

	app.get("/v1/packs", (c) => {
		let project: string
		try {
			project = projectOf(c.req.query("project"))
		} catch (err) {
			return failure(c, err, 400)
		}
		return c.json(describePacks(registryOf(project)))
	})

	app.get("/v1/slots", (c) => {
		const recipeId = c.req.query("recipe")
		if (!recipeId) {
			return apiError(
				c,
				400,
				"bad-request",
				"the recipe query param is required (pack is optional)",
				"GET /v1/slots?recipe=<id>[&pack=<pack>]",
			)
		}
		try {
			const project = projectOf(c.req.query("project"))
			const registry = registryOf(project)
			return c.json(listRecipeSlots(registry, packOf(registry, c.req.query("pack"), recipeId), recipeId))
		} catch (err) {
			return failure(c, err, 404)
		}
	})

	app.get("/v1/preview", (c) => {
		const recipeId = c.req.query("recipe")
		if (!recipeId) {
			return apiError(
				c,
				400,
				"bad-request",
				"the recipe query param is required (pack is optional)",
				"GET /v1/preview?recipe=<id>[&pack=<pack>]",
			)
		}
		try {
			const project = projectOf(c.req.query("project"))
			const registry = registryOf(project)
			return c.json(previewRecipe(registry, packOf(registry, c.req.query("pack"), recipeId), recipeId))
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
		if (!parsed.success) return badBody(c, parsed.error)
		let project: string
		try {
			project = projectOf(parsed.data.project)
		} catch (err) {
			return failure(c, err, 400)
		}
		let lock: ReturnType<typeof readLockfile>
		let registry: PackRegistry
		let pack: string
		let worker: { provider: LLMProvider | null; model: string }
		try {
			// A project that has a baka.lock.json is held to it on every run.
			lock = readLockfile(project)
			registry = registryOf(project)
			pack = packOf(registry, parsed.data.pack, parsed.data.recipe)
			worker = await workerFor(project, parsed.data.llm)
		} catch (err) {
			return failure(c, err, 400)
		}
		const result = await runRecipe({
			registry,
			lock: lock ?? undefined,
			store: createDiskSlotStore(project, { userFallback: !isolated }),
			pack,
			recipe: parsed.data.recipe,
			params: parsed.data.params,
			provider: worker.provider,
			model: worker.model,
			dryRun: parsed.data.dryRun,
			slots: parsed.data.slots,
			onExisting: parsed.data.onExisting,
			includeContent: parsed.data.includeContent,
			validate: parsed.data.validate,
			format: parsed.data.format,
			addons: opts.addons,
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
		if (!parsed.success) return badBody(c, parsed.error)
		try {
			const project = projectOf(parsed.data.project)
			const registry = registryOf(project)
			const packName = packOf(registry, parsed.data.pack, parsed.data.recipe)
			const { packRoot, recipe } = resolveRecipe(registry, packName, parsed.data.recipe)
			const templatesDir = join(packRoot, recipe.id, "templates")
			if (!existsSync(templatesDir)) {
				return apiError(c, 400, "bad-request", `recipe "${recipe.id}" has no templates/`)
			}
			// A run keys its slot cache by the params after defaults and coercion, so a fill must too.
			const normalized = normalizeParams(recipe.params, parsed.data.params)
			if (!normalized.ok) {
				return apiError(c, 400, "invalid-params", `params for ${packName}/${parsed.data.recipe}: ${normalized.message}`)
			}
			const paramsHash = hashBytes(canonicalJson(normalized.params))
			const { files, slots } = parseRecipeTemplates(templatesDir)
			const slot = slots.find((s) => s.id === parsed.data.slot)
			if (!slot) {
				return apiError(c, 404, "slot-unknown", `slot "${parsed.data.slot}" not found`)
			}
			const template = files.find((f) => f.rel === slot.file)
			if (!template) {
				return apiError(c, 500, "internal", `template for slot "${slot.id}" missing`)
			}
			const model = "manual"
			const key = slotCacheKey({
				templateHash: hashBytes(template.source),
				slotId: slot.id,
				paramsHash,
				model,
			})
			const path = writeSlotCache(project, {
				key,
				slotId: slot.id,
				kind: slot.kind,
				value: parsed.data.value,
				model,
				templateHash: hashBytes(template.source),
				paramsHash,
			})
			return c.json({ schema: "baka.fill/1", ok: true, slot: slot.id, cachePath: path, key })
		} catch (err) {
			return failure(c, err, 400)
		}
	})

	app.post("/v1/validate", async (c) => {
		let body: z.infer<typeof ValidateBodySchema> = {}
		try {
			const raw = await c.req.json()
			const parsed = ValidateBodySchema.safeParse(raw)
			if (!parsed.success) return badBody(c, parsed.error)
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
			return c.json(await validateProject(registryOf(project), body.pack))
		} catch (err) {
			if (err instanceof PackNotFoundError) return apiError(c, 400, "pack-not-found", err.message)
			throw err
		}
	})

	app.all("/mcp", (c) => {
		return apiError(
			c,
			501,
			"not-implemented",
			"stdio MCP is baka-mcp; JSON tools are /v1/*. Hosts without a shell spawn baka-mcp.",
		)
	})

	return app
}

export async function engineRequest(
	cwd: string,
	path: string,
	init?: {
		method?: string
		body?: unknown
		packDirs?: readonly string[]
		isolated?: boolean
		llm?: LlmCall
		bundledPacksDir?: string
		addons?: readonly BakaAddon[]
	},
): Promise<{ status: number; json: unknown }> {
	const app = createEngineApp({
		cwd,
		packDirs: init?.packDirs,
		isolated: init?.isolated,
		llm: init?.llm,
		bundledPacksDir: init?.bundledPacksDir,
		addons: init?.addons,
	})
	const res = await app.request(path, {
		method: init?.method ?? "GET",
		headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
		body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
	})
	return { status: res.status, json: await res.json() }
}
