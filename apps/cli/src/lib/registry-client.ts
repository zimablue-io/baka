/**
 * Thin HTTP client for the baka registry.
 *
 * The base URL resolution order for the CLI surfaces that drive a
 * single registry (login / logout / whoami / install from registry):
 *   1. `--registry <url>` flag (CLI only)
 *   2. `BAKA_REGISTRY_URL` env var
 *   3. Default: `http://localhost:4300`
 *
 * The default will move once the public hub is deployed; until then,
 * localhost is the honest default and matches the registry dev server
 * bound by `services.yaml`.
 *
 * Credential isolation: the client never logs request headers and never
 * echoes `apiKey` values. Callers mask the key when they need to print
 * it (see `maskApiKey`).
 */

/**
 * `401, 403` for an API key credential, `404, 500` for an upstream
 * error. Distinct from `RegistryTransportError`: a reachable registry
 * answering with a non-2xx status is a `RegistryHttpError`.
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

/**
 * The registry itself could not be reached (DNS, connection refused,
 * timeout). Distinct from `RegistryHttpError`: callers must be able to
 * tell "the service is down" apart from "the service answered". The
 * `baseUrl` is the URL the request was aimed at; the `path` is the
 * relative URL path. The `cause` is the underlying error message
 * (never the full credential).
 */
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
	body?: unknown
	method?: "GET" | "POST" | "DELETE"
	fetchImpl?: typeof fetch
}

interface ParsedResponse<T> {
	ok: boolean
	status: number
	body: T | null
	text: string
}

/**
 * Issues a request to the registry, parsing JSON when possible.
 * Transport errors wrap the underlying failure (never the credential);
 * HTTP errors carry the status and body text so callers can surface
 * the registry's own message verbatim.
 */
async function request<T>(path: string, opts: RequestOptions): Promise<ParsedResponse<T>> {
	const f = opts.fetchImpl ?? globalThis.fetch
	const headers: Record<string, string> = {}
	if (opts.apiKey) headers["x-api-key"] = opts.apiKey
	if (opts.body !== undefined) headers["content-type"] = "application/json"
	let res: Response
	try {
		res = await f(`${opts.baseUrl}${path}`, {
			method: opts.method ?? "GET",
			headers,
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		})
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

/**
 * Calls `GET /api/auth/get-session` with the supplied API key. Returns
 * the resolved user identity (id, name, email) or `null` when the key
 * is rejected. Throws `RegistryTransportError` for connection failures.
 */
interface RegistryIdentity {
	userId: string
	name: string | null
	email: string | null
}

interface SessionResponse {
	user?: { id?: string; name?: string | null; email?: string | null }
	session?: { id?: string }
}

export async function whoami(opts: {
	baseUrl: string
	apiKey: string
	fetchImpl?: typeof fetch
}): Promise<RegistryIdentity | null> {
	const res = await request<SessionResponse>("/api/auth/get-session", {
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
	})
	if (res.status === 401 || res.status === 403) return null
	if (res.status === 404) return null
	if (!res.ok) {
		throw new RegistryHttpError(opts.baseUrl, "/api/auth/get-session", res.status, res.text)
	}
	const user = res.body?.user
	if (!user || typeof user.id !== "string" || user.id.length === 0) return null
	return {
		userId: user.id,
		name: typeof user.name === "string" ? user.name : null,
		email: typeof user.email === "string" ? user.email : null,
	}
}

/**
 * Masks an API key for display: shows the last 4 characters, prefixes
 * with `…`. Used everywhere a key could otherwise be echoed to stdout
 * or stderr (VAL-DISC-033, VAL-AUTH-014).
 */
export function maskApiKey(key: string): string {
	if (key.length <= 4) return "…"
	return `…${key.slice(-4)}`
}

// ---------------------------------------------------------------------------
// Catalog + module detail (milestone 5, cli-search-multiregistry consumers).
//
// The CLI replaces the old `@baka/api` marketplace surface with the
// apps/registry catalog endpoints. Both GETs carry the API key header
// when present so org-visibility entries surface for members without
// forcing a re-prompt for credentials.
// ---------------------------------------------------------------------------

/**
 * One row of the catalog list response from `GET /v1/modules`. Mirrors
 * the schema served by `apps/registry/src/catalog/routes.ts` — kept
 * narrow here so the CLI does not pick up fields the registry has not
 * actually emitted.
 */
export interface RegistryCatalogEntry {
	scope: string
	name: string
	tier: string
	visibility: "public" | "org"
	description: string
	latestVersion: string | null
	latestStatus: string | null
}

interface CatalogListResponse {
	modules: RegistryCatalogEntry[]
}

/**
 * Calls `GET /v1/modules`. Returns the full visible-to-caller
 * catalog for the registry. Throws `RegistryTransportError` for
 * transport failures and `RegistryHttpError` for non-2xx
 * responses; callers must catch and isolate per-source failures
 * (decision 4 — multi-registry search degrades honestly).
 */
export async function getCatalog(opts: {
	baseUrl: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<RegistryCatalogEntry[]> {
	const res = await request<CatalogListResponse>("/v1/modules", {
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
	})
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, "/v1/modules", res.status, res.text)
	}
	return res.body.modules
}

/**
 * Module detail record from `GET /v1/modules/:scope/:name`. The CLI
 * uses the `latestVersion` field for the latest-pointer assertions
 * (VAL-DISC-038) and the `tier` / `description` for `baka registry
 * info` display (VAL-DISC-030). The 404-vs-tombstone vs org-private
 * shape returns `null` so callers can branch on transport-404
 * (truly missing) versus tombstone / visibility-blocked responses
 * later if needed.
 */
interface RegistryModuleDetail {
	scope: string
	name: string
	tier: string
	visibility: "public" | "org"
	description: string
	latestVersion: string | null
	versions: Array<{ version: string; status: string; createdAt: string }>
}

/**
 * Calls `GET /v1/modules/:scope/:name`. Returns the parsed detail
 * on 2xx, `null` on 404 (so callers can fall through to the next
 * registry in precedence order without confusing a missing module
 * for a transport failure). Any other non-2xx response throws
 * `RegistryHttpError`; transport failures throw
 * `RegistryTransportError`.
 */
export async function getModuleDetail(opts: {
	baseUrl: string
	scope: string
	name: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<RegistryModuleDetail | null> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}`
	const res = await request<RegistryModuleDetail>(path, {
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
	})
	if (res.status === 404) return null
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, res.text)
	}
	return res.body
}

// ---------------------------------------------------------------------------
// Publish / version detail / org surfaces (milestone 5, cli-publish-org +
// cli-search-multiregistry consumers).
// ---------------------------------------------------------------------------

export interface PublishBody {
	repo: string
	tag: string
	org: string
	modulePath?: string
	visibility?: "org" | "public"
}

interface PublishAcceptedResponse {
	scope: string
	name: string
	version: string
	commitSha: string
	status: "pending" | "ingesting" | "ready" | "failed"
	visibility: "org" | "public"
	versionId: string
}

interface VersionDetailResponse {
	scope: string
	name: string
	tier: string
	version: string
	status: "pending" | "ingesting" | "ready" | "failed"
	commitSha: string
	contentHash: string
	error: string | null
	screening: { verdict: string } | null
}

interface OrgCreateResponse {
	id: string
	slug: string
	name: string
}

interface OrgListEntry {
	id: string
	slug: string
	name: string
	role: string
}

interface OrgInviteResponse {
	id: string
}

/**
 * Issues `POST /v1/publish` against the registry. Throws
 * `RegistryTransportError` for connection failures and
 * `RegistryHttpError` for non-2xx responses; the body is preserved on
 * the HTTP error so callers can surface the registry's typed message
 * verbatim. The publish endpoint's contract (VAL-PUB-002 / VAL-AUTH-009 /
 * VAL-PUB-020): 202 accepted (status=pending); 403 role/origin failures;
 * 401 unauthenticated; 422 field-level validation failures. Callers
 * branch on `err.status` to render role-403 vs schema-422 distinctly.
 */
export async function publishToRegistry(opts: {
	baseUrl: string
	apiKey: string
	body: PublishBody
	fetchImpl?: typeof fetch
}): Promise<PublishAcceptedResponse> {
	const res = await request<PublishAcceptedResponse>("/v1/publish", {
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		body: opts.body,
		method: "POST",
		fetchImpl: opts.fetchImpl,
	})
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, "/v1/publish", res.status, res.text)
	}
	return res.body
}

/**
 * Polls `GET /v1/modules/:scope/:name/:version` until the version
 * reaches a terminal state (`ready` / `failed`). Returns the latest
 * detail JSON. Throws `RegistryTransportError` on connection
 * failures and `RegistryHttpError` for non-2xx. Polling cadence is
 * 500ms (the worker poll interval is 250ms; 500ms gives the worker
 * one full cycle to react); default timeout 60s.
 */
export async function pollVersionStatus(opts: {
	baseUrl: string
	apiKey: string | undefined
	scope: string
	name: string
	version: string
	timeoutMs?: number
	intervalMs?: number
	fetchImpl?: typeof fetch
}): Promise<VersionDetailResponse> {
	const intervalMs = opts.intervalMs ?? 500
	const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}`
	let lastText = ""
	while (true) {
		const res = await request<VersionDetailResponse>(path, {
			baseUrl: opts.baseUrl,
			apiKey: opts.apiKey,
			fetchImpl: opts.fetchImpl,
		})
		if (!res.ok) {
			throw new RegistryHttpError(opts.baseUrl, path, res.status, res.text)
		}
		if (res.body !== null) {
			if (res.body.status === "ready" || res.body.status === "failed") {
				return res.body
			}
			lastText = res.text
		}
		if (Date.now() > deadline) {
			throw new RegistryHttpError(
				opts.baseUrl,
				path,
				408,
				`timed out polling for terminal status; last body: ${lastText}`,
			)
		}
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

/**
 * Creates an org via `POST /v1/orgs`. The body shape mirrors the
 * Better-Auth organization plugin's expected input (`name`, `slug`).
 * Returns the parsed JSON on a 200; throws `RegistryHttpError` with
 * the registry's typed envelope on every other status (so the CLI
 * can branch on duplicate-slug 4xx vs transport failure honestly).
 */
export async function createOrg(opts: {
	baseUrl: string
	apiKey: string
	body: { name: string; slug: string }
	fetchImpl?: typeof fetch
}): Promise<OrgCreateResponse> {
	const res = await request<OrgCreateResponse>("/v1/orgs", {
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		body: opts.body,
		method: "POST",
		fetchImpl: opts.fetchImpl,
	})
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, "/v1/orgs", res.status, res.text)
	}
	return res.body
}

/**
 * Lists the caller's orgs via `GET /v1/orgs`. Each entry carries the
 * caller's role on that org (VAL-AUTH-006). The endpoint returns an
 * empty array for callers with no memberships.
 */
export async function listOrgs(opts: {
	baseUrl: string
	apiKey: string
	fetchImpl?: typeof fetch
}): Promise<OrgListEntry[]> {
	const res = await request<OrgListEntry[] | null>("/v1/orgs", {
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
	})
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, "/v1/orgs", res.status, res.text)
	}
	return res.body
}

/**
 * Sends an invitation via `POST /v1/orgs/:slug/invite`. The body
 * shape mirrors Better-Auth's `organization/invite-member`
 * (`{ email, role }`); `role` is `owner | admin | member` per the
 * Better-Auth vocabulary.
 */
export async function inviteToOrg(opts: {
	baseUrl: string
	apiKey: string
	slug: string
	body: { email: string; role: "owner" | "admin" | "member" }
	fetchImpl?: typeof fetch
}): Promise<OrgInviteResponse> {
	const path = `/v1/orgs/${encodeURIComponent(opts.slug)}/invite`
	const res = await request<OrgInviteResponse>(path, {
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		body: opts.body,
		method: "POST",
		fetchImpl: opts.fetchImpl,
	})
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, res.text)
	}
	return res.body
}
