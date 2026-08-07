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

// ---------------------------------------------------------------------------
// Module detail + version detail + previews (milestone 5,
// cli-info-preview, VAL-DISC-030 / VAL-DISC-031).
//
// The CLI's `baka registry info` command fetches the module detail
// AND the version detail (manifest) so the served JSON is
// field-for-field equal to the registry's two endpoints (the
// assertion pins byte-equal shape). The `baka registry preview`
// command fetches the previews list AND, when `--action <id>` is
// supplied, the per-action detail (file CONTENTS for `rendered`,
// needs-llm reason for that state). Both flows honor the same
// visibility rules as the install path: an org-visibility module
// returns the uniform 404 envelope an outsider would see for a
// missing module.
//
// The fetch helpers below narrow the response shapes to the
// fields the CLI surfaces (mirroring the install surface's
// `VersionDetailForInstall` so we don't pull in the full
// `VersionDetailResponse` schema). Errors are the same shape as
// every other registry-client method: `RegistryTransportError`
// for transport failures, `RegistryHttpError` for non-2xx
// responses with the registry's own body text.
// ---------------------------------------------------------------------------

/**
 * Module detail record from `GET /v1/modules/:scope/:name`. Mirrors
 * the JSON the registry serves (architecture §4.5, decision 25,
 * decision 31): scope, name, tier, visibility, description,
 * latestVersion (semver max of ready versions), and the full
 * versions list (each entry: version, status, createdAt).
 *
 * Internal type — only the CLI's `runRegistryInfo` command
 * consumes it. External callers should branch on the JSON shape
 * directly; the type is a contract pin between the read endpoint
 * and the CLI's `--json` payload (VAL-DISC-030 byte-equal pin).
 */
interface ModuleDetail {
	scope: string
	name: string
	tier: string
	visibility: string
	description: string
	latestVersion: string | null
	versions: Array<{ version: string; status: string; createdAt: string }>
}

/**
 * Version detail record from
 * `GET /v1/modules/:scope/:name/:version`. `baka registry info`
 * uses the `manifest` field to display every action with its
 * params and descriptions, and the `screening` field to surface
 * the verdict (or `null` for unscreened versions). The full
 * version-detail response carries more (artifacts, commit sha,
 * content hash); those fields are reserved for the install flow
 * (see `getVersionDetailForInstall` above) — `info` does not need
 * the artifact row list. Internal type for the same reason.
 */
interface VersionDetail {
	scope: string
	name: string
	tier: string
	version: string
	status: string
	commitSha: string
	contentHash: string
	error: string | null
	manifest: Record<string, unknown>
	screening: {
		verdict: string
		staticScan?: unknown
		dryRun?: unknown
		outputValidation?: unknown
		createdAt?: string | null
	} | null
	createdAt: string
}

/**
 * One entry of the previews list from
 * `GET /v1/modules/:scope/:name/:version/previews` (decision 31).
 * The `rendered` state carries `files`; the `needs-llm` state
 * carries no `files` (the per-action detail endpoint surfaces
 * the rendered sentinel bytes separately when present). The CLI
 * prints both states honestly — fabricated code for `needs-llm`
 * is a contract violation. Internal type.
 */
interface ModulePreviewEntry {
	actionId: string
	state: "rendered" | "needs-llm"
	files?: Array<{ path: string; size: number; sha256: string }>
}

/**
 * Single-action preview detail from
 * `GET /v1/modules/:scope/:name/:version/previews/:actionId`.
 * The `rendered` state carries `files[]` with the actual bytes
 * (the CLI prints them byte-equal to the served response); the
 * `needs-llm` state carries a `reason` (the documented
 * "action skipped because it requires LLM reasoning" string)
 * and optionally a `files[]` when a sentinel render was produced
 * (architecture §4.6 layer 2 + library/no-llm-sentinel-preview).
 * Internal type.
 */
interface ActionPreview {
	actionId: string
	state: "rendered" | "needs-llm"
	reason?: string
	files?: Array<{ path: string; content: string; size: number; sha256: string }>
}

/**
 * Calls `GET /v1/modules/:scope/:name` for the `info` surface.
 * Returns the parsed detail on a 200, `null` on a 404 (the
 * caller surfaces this as "not found"). Any other non-2xx
 * response throws `RegistryHttpError`; transport failures throw
 * `RegistryTransportError`.
 */
export async function getModuleDetail(opts: {
	baseUrl: string
	scope: string
	name: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<ModuleDetail | null> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}`
	const res = await request<ModuleDetail>(path, {
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

/**
 * Calls `GET /v1/modules/:scope/:name/:version` for the `info`
 * surface (the manifest lives on the version-detail endpoint,
 * not the module-detail endpoint). The CLI fetches BOTH endpoints
 * so the served JSON is field-for-field equal to the two
 * registry responses (VAL-DISC-030 contract pin).
 */
export async function getVersionDetail(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<VersionDetail | null> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}`
	const res = await request<VersionDetail>(path, {
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

/**
 * Calls `GET /v1/modules/:scope/:name/:version/previews` (decision
 * 31). Returns the list of preview records (one per manifest
 * action, with state `rendered` | `needs-llm`). An empty list
 * means the version was never screened (e.g. built-in modules
 * per decision 31, or org-visibility modules that skip the
 * pipeline). The CLI surfaces the empty list as an explicit
 * "no preview available" line per the contract.
 */
export async function getModulePreviews(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<ModulePreviewEntry[]> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}/previews`
	const res = await request<{ previews: ModulePreviewEntry[] }>(path, {
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
	})
	if (res.status === 404) return []
	if (!res.ok || res.body === null) {
		throw new RegistryHttpError(opts.baseUrl, path, res.status, res.text)
	}
	return res.body.previews
}

/**
 * Calls `GET /v1/modules/:scope/:name/:version/previews/:actionId`
 * (decision 31, VAL-SCAN-004). Returns the per-action preview
 * detail (file CONTENTS for `rendered`, reason for `needs-llm`,
 * null on 404 — i.e. the action has no preview record). The CLI
 * distinguishes "no record" (404) from "needs-llm" (200 with
 * state=needs-llm) so the user can tell the two apart.
 */
export async function getActionPreview(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	actionId: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<ActionPreview | null> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}/previews/${encodeURIComponent(opts.actionId)}`
	const res = await request<ActionPreview>(path, {
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
// Install flow (architecture §5.1, milestone 5 cli-install).
//
// The CLI's install pipeline resolves a `@scope/name[@version]` spec
// through the configured registries, then for the winning registry
// fetches (a) the version-detail JSON (which carries the manifest)
// and (b) the tarball artifact. Both endpoints are gated by the
// standard visibility rules: an org-visibility module returns 404 to
// non-members uniformly (VAL-AUTH-003 / VAL-PUB-017) so the CLI's
// error message names both possibilities ("not found or private")
// rather than leaking existence.
//
// The download carries `x-content-sha256` in its headers
// (architecture §4.5, VAL-PUB-007). The CLI compares that header
// against the sha256 of the actual bytes it received (VAL-DISC-041)
// — a mismatch is an explicit install refusal, never a silent
// partial install.
// ---------------------------------------------------------------------------

/**
 * Mirrors the version-detail JSON the registry serves at
 * `GET /v1/modules/:scope/:name/:version`. The CLI narrows this
 * surface to the fields the install flow needs (manifest, content
 * hash, status). The full version-detail response carries more
 * (screening verdict, artifacts, etc.) — those fields are reserved
 * for `baka registry info` and the MCP registry-detail tools.
 */
interface VersionDetailForInstall {
	scope: string
	name: string
	version: string
	status: "pending" | "ingesting" | "ready" | "failed"
	contentHash: string
	commitSha: string
	visibility: "public" | "org"
	tier: string
	manifest: {
		name: string
		version: string
		description?: string
		dependencies?: string[]
		conflictsWith?: string[]
		actions?: Array<{
			id: string
			description?: string
			params?: unknown[]
			requiresReasoning?: boolean
			filePatterns?: string[]
			validators?: string[]
		}>
		moduleValidators?: string[]
		[key: string]: unknown
	}
}

/**
 * Calls `GET /v1/modules/:scope/:name/:version` for the install
 * path. Returns the parsed detail on a 200, `null` on a 404 (so
 * the CLI can fall through to the next registry in precedence
 * order without confusing a missing module for a transport
 * failure). Any other non-2xx response throws `RegistryHttpError`;
 * transport failures throw `RegistryTransportError`.
 */
export async function getVersionDetailForInstall(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<VersionDetailForInstall | null> {
	const path = `/v1/modules/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}`
	const res = await request<VersionDetailForInstall>(path, {
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

/**
 * Downloads the tarball artifact for `scope/name/version`. The
 * caller is responsible for integrity verification (compare
 * `expectedSha256` against the sha256 of `bytes`); the registry's
 * `x-content-sha256` header is the source of truth (VAL-DISC-041).
 *
 * The function distinguishes three failure modes a CLI install
 * must surface honestly:
 *   - 404 (uniform for missing module / missing version / org-
 *     visibility outsider) → caller throws "not found or private".
 *   - 410 (tombstoned module, only reachable for proven members)
 *     → caller throws "module was removed".
 *   - Transport failure → caller surfaces the registry URL.
 *   - HTTP 5xx with a JSON body → the error message from the
 *     registry (the CLI never invents context the server didn't
 *     provide).
 */
export async function downloadTarball(opts: {
	baseUrl: string
	scope: string
	name: string
	version: string
	apiKey?: string
	fetchImpl?: typeof fetch
}): Promise<{ bytes: Uint8Array; expectedSha256: string | null }> {
	const f = opts.fetchImpl ?? globalThis.fetch
	const path = `/v1/download/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/${encodeURIComponent(opts.version)}`
	const headers: Record<string, string> = {}
	if (opts.apiKey) headers["x-api-key"] = opts.apiKey
	let res: Response
	try {
		res = await f(`${opts.baseUrl}${path}`, {
			method: "GET",
			headers,
			...(opts.fetchImpl ? {} : { redirect: "manual" }),
		})
	} catch (err) {
		const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
		throw new RegistryTransportError(opts.baseUrl, path, cause)
	}
	if (res.status === 404) {
		// Existence is not leaked — the registry returns 404 for
		// missing module, missing version, AND org-visibility
		// outsiders. The CLI surfaces this as "not found or
		// private" so the caller cannot distinguish the two from
		// the response alone (VAL-DISC-019, VAL-PUB-017).
		throw new RegistryDownloadNotFound(opts.baseUrl, opts.scope, opts.name, opts.version)
	}
	if (res.status === 410) {
		throw new RegistryDownloadGone(opts.baseUrl, opts.scope, opts.name, opts.version)
	}
	if (!res.ok) {
		const text = await res.text().catch(() => "")
		throw new RegistryHttpError(opts.baseUrl, path, res.status, text)
	}
	const expectedSha256 = res.headers.get("x-content-sha256")
	const ab = await res.arrayBuffer()
	return { bytes: new Uint8Array(ab), expectedSha256 }
}

/**
 * Distinguishes a uniform 404 from the download endpoint so the CLI
 * can render "not found or private" honestly (VAL-DISC-019). The
 * registry collapses three states (missing module, missing version,
 * org-visibility outsider) into the same 404 envelope so existence
 * is not leaked — the CLI matches that contract.
 */
export class RegistryDownloadNotFound extends Error {
	readonly baseUrl: string
	readonly scope: string
	readonly name: string
	readonly version: string
	constructor(baseUrl: string, scope: string, name: string, version: string) {
		super(
			`registry ${baseUrl} returned 404 for ${scope}/${name}@${version} (not found, missing version, or org-visibility outsider)`,
		)
		this.name = "RegistryDownloadNotFound"
		this.baseUrl = baseUrl
		this.scope = scope
		this.name = name
		this.version = version
	}
}

/**
 * The download endpoint returns 410 Gone for a tombstoned module
 * (architecture §8 decision 1; VAL-PUB-030). Only members of the
 * owning org reach this branch — outsiders get the uniform 404
 * via `RegistryDownloadNotFound`.
 */
export class RegistryDownloadGone extends Error {
	readonly baseUrl: string
	readonly scope: string
	readonly name: string
	readonly version: string
	constructor(baseUrl: string, scope: string, name: string, version: string) {
		super(
			`registry ${baseUrl} returned 410 for ${scope}/${name}@${version} (module was removed; existing local installs are unaffected)`,
		)
		this.name = "RegistryDownloadGone"
		this.baseUrl = baseUrl
		this.scope = scope
		this.name = name
		this.version = version
	}
}

/**
 * Thrown when the version-detail JSON reports a non-`ready`
 * status (pending/ingesting/failed). The CLI refuses to install a
 * non-ready version — pending means the worker hasn't finished
 * producing the artifact yet (VAL-PUB-018); failed means the
 * registry has a recorded reason the version never made it
 * (VAL-PUB-012 / VAL-PUB-014).
 */
export class RegistryVersionNotReadyError extends Error {
	readonly status: string
	readonly error: string | null
	constructor(scope: string, name: string, version: string, status: string, error: string | null) {
		super(
			`version ${scope}/${name}@${version} is not installable (status='${status}'${error ? `, registry error='${error}'` : ""})`,
		)
		this.name = "RegistryVersionNotReadyError"
		this.status = status
		this.error = error
	}
}
