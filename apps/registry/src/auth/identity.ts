import type { IncomingHttpHeaders } from "node:http"

/**
 * Identity resolver (architecture §4.4, decision 11).
 *
 * The registry has two credential paths that MUST resolve to the same
 * underlying user:
 *   - Browser session cookie (set by Better-Auth after a successful
 *     GitHub OAuth completion).
 *   - API key in the `x-api-key` header (issued by Better-Auth's
 *     `apiKey` plugin to CLI tools).
 *
 * Better-Auth's `getSession` handles both: when an API key is present
 * the apiKey middleware resolves it to a synthetic session, so the same
 * `user.id` is returned regardless of credential path. This pack
 * exposes that resolution as a single typed helper so future endpoints
 * (publish, org mutations, etc.) can use it without re-implementing the
 * branching logic.
 *
 * `null` is returned when neither credential path is valid; the caller
 * decides whether that means `401` (write endpoint) or "anonymous read"
 * (visibility-aware read endpoint).
 */

interface Identity {
	userId: string
	sessionId: string | null
}

/**
 * Resolves the current request's identity from session cookie or API key.
 * Returns `null` when neither is present or valid — never throws, never
 * fabricates a user.
 *
 * The session lookup is wrapped in a try/catch because Better-Auth's
 * `getSession` throws `APIError(FORBIDDEN)` for malformed credentials
 * (the apiKey plugin rejects unknown keys with a 403 that bubbles up
 * the call stack). A thrown error here would 500 every auth-gated
 * `/v1/*` route instead of returning the documented 401 envelope. The
 * wrapper downgrades any thrown value to `null`; the caller decides
 * whether that means `401` (write endpoint) or "anonymous read"
 * (visibility-aware read endpoint).
 */
export async function resolveIdentity(
	auth: ReturnType<typeof import("better-auth").betterAuth>,
	request: Request,
): Promise<Identity | null> {
	const headers = webHeadersToIncoming(request.headers)
	let result: Awaited<ReturnType<typeof auth.api.getSession>> | null = null
	try {
		result = await auth.api.getSession({ headers, asResponse: false })
	} catch {
		return null
	}
	if (!result) return null
	const userId = result.user?.id
	if (typeof userId !== "string" || userId.length === 0) return null
	const sessionId = result.session?.id ?? null
	return { userId, sessionId }
}

/**
 * Converts a Web `Headers` instance to Node's `IncomingHttpHeaders`
 * shape so Better-Auth's `fromNodeHeaders` adapter can consume it.
 * Header names are lowercased (the canonical form Node uses).
 */
function webHeadersToIncoming(headers: Headers): IncomingHttpHeaders {
	const out: IncomingHttpHeaders = {}
	for (const [name, value] of headers.entries()) {
		out[name.toLowerCase()] = value
	}
	return out
}

// 401 envelope helper is intentionally not exported — every
// auth-gated route uses `resolveIdentity` + a hand-rolled `c.json(...)`
// 401 response so the response shape matches the per-route error
// vocabulary. If a future caller needs a reusable helper, re-export
// the function and wire it into the routes that consume it.
