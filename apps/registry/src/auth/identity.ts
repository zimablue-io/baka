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
 * `user.id` is returned regardless of credential path. This module
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
 */
export async function resolveIdentity(
	auth: ReturnType<typeof import("better-auth").betterAuth>,
	request: Request,
): Promise<Identity | null> {
	const headers = webHeadersToIncoming(request.headers)
	const result = await auth.api.getSession({ headers, asResponse: false })
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

/**
 * Returns a 401 JSON response for endpoints that require authentication.
 * The shape is stable so future validators can grep for the `error`
 * field without parsing free text.
 */
export function unauthorizedJson(): Response {
	return new Response(JSON.stringify({ error: "authentication required" }), {
		status: 401,
		headers: { "content-type": "application/json" },
	})
}
