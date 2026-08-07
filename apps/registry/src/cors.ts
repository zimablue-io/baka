import type { MiddlewareHandler } from "hono"

/**
 * Permissive CORS middleware for the registry (architecture §5.3).
 *
 * The landing app fetches the catalog cross-origin (default
 * `http://localhost:4301` → `http://localhost:4300`). Without CORS
 * headers the browser blocks the request before it reaches the
 * route handler, so a permissive Access-Control-Allow-Origin is
 * required for VAL-WEB-001 / VAL-WEB-017 to pass.
 *
 * The middleware:
 *   - echoes the request's Origin on every response so the
 *     browser accepts the response (a literal `*` would also work
 *     for non-credentialed reads, but echoing lets us set
 *     `Access-Control-Allow-Credentials` later if the surface
 *     needs it without revisiting every response);
 *   - declares the methods + headers the catalog, publish, and
 *     Better-Auth surfaces need;
 *   - short-circuits `OPTIONS` preflight requests with a 204 so
 *     the browser can probe the route without invoking the full
 *     route chain (Hono's middleware order matters: this MUST
 *     run before the auth / route handlers, otherwise the
 *     preflight hits a 404 or a 401 and the browser blocks the
 *     subsequent real request).
 *
 * The Better-Auth origin check (architecture §4.4 / VAL-AUTH-010)
 * is a separate gate on mutating session-cookie requests; this
 * middleware does NOT bypass it. The two checks compose honestly:
 * CORS lets the browser reach the handler; the origin check
 * (which compares `Origin` to `trustedOrigins`) decides whether
 * a session-cookie mutation is allowed.
 *
 * `Access-Control-Allow-Credentials` is intentionally omitted: the
 * catalog + previews are reachable unauthenticated (architecture
 * §8 decision 23), and any future authenticated surface should
 * opt into credentials explicitly rather than ship them as the
 * default.
 */

const ALLOWED_METHODS = "GET, POST, PUT, DELETE, PATCH, OPTIONS"
const ALLOWED_HEADERS = "Content-Type, Accept, Authorization, X-API-Key, X-Requested-With, Origin"
const MAX_AGE_SECONDS = "86400"

export function registryCors(): MiddlewareHandler {
	return async (c, next) => {
		const origin = c.req.header("origin")
		const hasOrigin = typeof origin === "string" && origin.length > 0

		if (c.req.method === "OPTIONS") {
			// Preflight short-circuit. The browser only sends
			// `Origin` + `Access-Control-Request-Method` +
			// `Access-Control-Request-Headers`; we don't need
			// the body, so a 204 with the right headers is the
			// canonical reply.
			const headers = new Headers()
			if (hasOrigin) {
				headers.set("access-control-allow-origin", origin)
				headers.set("vary", "Origin")
			}
			headers.set("access-control-allow-methods", ALLOWED_METHODS)
			headers.set("access-control-allow-headers", ALLOWED_HEADERS)
			headers.set("access-control-max-age", MAX_AGE_SECONDS)
			return new Response(null, { status: 204, headers })
		}

		await next()

		if (hasOrigin) {
			// Add the CORS headers to every response produced by
			// downstream middleware. We do this AFTER `next()` so
			// the headers ride along with whatever status code
			// the route handler chose (200, 401, 404, 500 — the
			// browser still needs to read the body to surface the
			// failure to JS).
			c.res.headers.set("access-control-allow-origin", origin)
			c.res.headers.set("vary", "Origin")
			c.res.headers.set("access-control-allow-methods", ALLOWED_METHODS)
			c.res.headers.set("access-control-allow-headers", ALLOWED_HEADERS)
		}
	}
}
