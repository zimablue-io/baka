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

export const DEFAULT_REGISTRY_URL = "http://localhost:4300"

/**
 * The default registry URL, overridable via the `--registry` flag, the
 * `BAKA_REGISTRY_URL` env var, or an explicit `apiUrl` argument. The
 * precedence matches the multi-registry install path (decision 4):
 * flag > env > default. Internal helper — the public CLI surface is
 * `resolveRegistryUrl` in `commands/registry.ts`.
 */
function _getRegistryUrl(apiUrl?: string): string {
	return apiUrl ?? process.env.BAKA_REGISTRY_URL ?? DEFAULT_REGISTRY_URL
}

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
