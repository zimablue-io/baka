import {
	type RegistryActionPreview,
	RegistryActionPreviewSchema,
	type RegistryCatalogEntry,
	RegistryCatalogResponseSchema,
	type RegistryModuleDetail,
	RegistryModuleDetailSchema,
	type RegistryPreviewListResponse,
	RegistryPreviewListResponseSchema,
	type RegistryVersionDetail,
	RegistryVersionDetailSchema,
} from "@repo/protocol"

/**
 * Thin HTTP client for the baka registry (mirrors
 * `apps/cli/src/lib/registry-client.ts`, MCP-side).
 *
 * The MCP registry tools (`baka_registry_search`,
 * `baka_registry_get_module`, `baka_registry_get_preview`) only
 * need the three read endpoints (`GET /v1/modules`,
 * `GET /v1/modules/<scope>/<name>`, `GET /v1/modules/<scope>/<name>/<version>`
 * and its `/previews` family). The MCP never installs, never
 * publishes, never admins orgs (architecture §8 decision 9:
 * "MCP has no install tool"; the install handoff is the CLI's
 * `baka install @scope/name`).
 *
 * Every response is parsed against a `Registry*Schema` from
 * `@repo/protocol` so the wire shape is guaranteed. A 404 on a
 * missing / private / tombstoned module returns `null`
 * (existence-leak parity with the CLI's surfaces — VAL-AUTH-003 /
 * VAL-DISC-019). Transport failures raise `RegistryTransportError`,
 * non-2xx HTTP responses raise `RegistryHttpError` with the
 * registry's own body text preserved.
 *
 * The credential model matches the CLI (decision 33 + decision 4):
 * the per-registry API key is passed as `x-api-key: <key>` when a
 * credential is stored for that registry URL. `public` modules
 * remain reachable without a credential (VAL-SCAN-019 / decision
 * 23); `org`-visibility modules fail honestly with the registry's
 * 401/404 envelope.
 */

export class RegistryHttpError extends Error {
	readonly status: number
	readonly baseUrl: string
	readonly path: string
	constructor(baseUrl: string, path: string, status: number, bodyText: string) {
		const summary = bodyText.length > 0 ? `: ${bodyText}` : ""
		super(`registry ${path} failed: HTTP ${status}${summary}`)
		this.name = "RegistryHttpError"
		this.status = status
		this.baseUrl = baseUrl
		this.path = path
	}
}

export class RegistryTransportError extends Error {
	readonly baseUrl: string
	readonly path: string
	constructor(baseUrl: string, path: string, cause: string) {
		super(`registry unreachable at ${baseUrl} (${path}): ${cause}`)
		this.name = "RegistryTransportError"
		this.baseUrl = baseUrl
		this.path = path
	}
}

interface RequestOptions {
	baseUrl: string
	apiKey?: string
	fetchImpl?: typeof fetch
}

interface ParsedResponse<T> {
	ok: boolean
	status: number
	body: T | null
	text: string
}

async function request<T>(path: string, opts: RequestOptions): Promise<ParsedResponse<T>> {
	const f = opts.fetchImpl ?? globalThis.fetch
	const headers: Record<string, string> = {}
	if (opts.apiKey) headers["x-api-key"] = opts.apiKey
	let res: Response
	try {
		res = await f(`${opts.baseUrl}${path}`, { method: "GET", headers })
	} catch (err) {
		const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
		throw new RegistryTransportError(opts.baseUrl, path, cause)
	}
	const text = await res.text().catch(() => "")
	let body: T | null = null
	if (text.length > 0) {
		try {
			body = JSON.parse(text) as T
		} catch {
			body = null
		}
	}
	return { ok: res.ok, status: res.status, body, text }
}

// ---------------------------------------------------------------------------
// /v1/modules — catalog list
// ---------------------------------------------------------------------------

/**
 * Calls `GET /v1/modules`. Returns the visible-to-caller catalog.
 * Throws `RegistryTransportError` for transport failures and
 * `RegistryHttpError` for non-2xx responses. Callers must catch and
 * isolate per-source failures (decision 4 + decision 27 — the MCP
 * tool surfaces the per-source failure as a structured error).
 */
export async function getCatalog(opts: {
	baseUrl: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<RegistryCatalogEntry[]> {
	const res = await request<unknown>("/v1/modules", opts)
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, "/v1/modules", res.status, res.text)
	}
	const parsed = RegistryCatalogResponseSchema.safeParse(res.body)
	if (!parsed.success) {
		throw new RegistryHttpError(opts.baseUrl, "/v1/modules", res.status, "registry returned an unparseable catalog")
	}
	return parsed.data.modules
}

// ---------------------------------------------------------------------------
// /v1/modules/:scope/:name — module detail
// ---------------------------------------------------------------------------

/**
 * Calls `GET /v1/modules/:scope/:name`. Returns the parsed detail
 * on a 200, `null` on a 404 (the caller surfaces this as "not
 * found" — existence-leak parity with the read surface). Any other
 * non-2xx response throws `RegistryHttpError`.
 */
export async function getModuleDetail(opts: {
	baseUrl: string
	scope: string
	name: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<RegistryModuleDetail | null> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}`
	const res = await request<unknown>(path, opts)
	if (res.status === 404) return null
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, res.text)
	}
	const parsed = RegistryModuleDetailSchema.safeParse(res.body)
	if (!parsed.success) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, "registry returned an unparseable module detail")
	}
	return parsed.data
}

// ---------------------------------------------------------------------------
// /v1/modules/:scope/:name/:version — version detail
// ---------------------------------------------------------------------------

/**
 * Calls `GET /v1/modules/:scope/:name/:version`. Returns the
 * parsed detail (manifest + screening + artifacts) on a 200, `null`
 * on a 404. The MCP tool surfaces `manifest` and `screening` (for
 * the official `"official"` tier badge and verdict display); the
 * CLI's `baka registry info` uses the same surface.
 */
export async function getVersionDetail(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<RegistryVersionDetail | null> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}`
	const res = await request<unknown>(path, opts)
	if (res.status === 404) return null
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, res.text)
	}
	const parsed = RegistryVersionDetailSchema.safeParse(res.body)
	if (!parsed.success) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, "registry returned an unparseable version detail")
	}
	return parsed.data
}

// ---------------------------------------------------------------------------
// /v1/modules/:scope/:name/:version/previews — preview list
// ---------------------------------------------------------------------------

/**
 * Calls `GET /v1/modules/:scope/:name/:version/previews` (decision 31,
 * VAL-SCAN-012). Returns the parsed list of preview records (one
 * per manifest action with `state: rendered | needs-llm`) on a 200,
 * `[]` when the version has no previews (the MCP tool surfaces the
 * empty list honestly: a module without previews prints an explicit
 * "no previews available" branch — fabricated code for `needs-llm`
 * actions is a contract violation, VAL-DISC-031).
 *
 * A 404 collapses three cases: missing module, missing version,
 * org-visibility outsider. The MCP tool surfaces these as a single
 * "not found" so the response cannot distinguish them; this matches
 * the CLI's `baka registry preview` shape for `org`-visibility
 * missing (VAL-DISC-019).
 */
export async function getModulePreviews(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<RegistryPreviewListResponse> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}/previews`
	const res = await request<unknown>(path, opts)
	if (res.status === 404) return { previews: [] }
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, res.text)
	}
	const parsed = RegistryPreviewListResponseSchema.safeParse(res.body)
	if (!parsed.success) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, "registry returned an unparseable preview list")
	}
	return parsed.data
}

// ---------------------------------------------------------------------------
// /v1/modules/:scope/:name/:version/previews/:actionId — per-action preview
// ---------------------------------------------------------------------------

/**
 * Calls
 * `GET /v1/modules/:scope/:name/:version/previews/:actionId`
 * (decision 31, VAL-SCAN-004 / VAL-DISC-031). Returns the
 * per-action record (`rendered` with file CONTENTS, or
 * `needs-llm` with reason), or `null` on a 404 (the action has
 * no happy-path preview — either the action is unknown to the
 * manifest, or the verdict is `failed`/`timed-out`).
 */
export async function getActionPreview(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	actionId: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<RegistryActionPreview | null> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}/previews/${encodeURIComponent(opts.actionId)}`
	const res = await request<unknown>(path, opts)
	if (res.status === 404) return null
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, res.text)
	}
	const parsed = RegistryActionPreviewSchema.safeParse(res.body)
	if (!parsed.success) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, "registry returned an unparseable action preview")
	}
	return parsed.data
}
