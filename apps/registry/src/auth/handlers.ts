import type { betterAuth } from "better-auth"
import { Hono } from "hono"

/**
 * Hono mount helpers for the Better-Auth handler (architecture §4.4).
 *
 * Better-Auth exposes a single Fetch-API handler
 * (`auth.handler(request) → response`). Mounting it on Hono routes every
 * `/api/auth/*` request through Better-Auth's router — sign-in, callback,
 * get-session, sign-out, organization CRUD, api-key CRUD, etc.
 *
 * The mount is `app.on(["GET","POST"], "/api/auth/*", ...)` so both the
 * browser-flow OAuth dance (GET on `/api/auth/callback/github`) and the
 * write endpoints (POST) are routed correctly.
 *
 * Two wrapping middlewares enforce credential isolation (VAL-AUTH-014)
 * and the 401-not-500 surface for invalid api keys (VAL-AUTH-012 / 013):
 *
 * 1. A 403 → 401 translator. When the request presents an `x-api-key`
 *    header and Better-Auth rejects it (malformed, unknown, expired,
 *    disabled), the plugin's hook throws `FORBIDDEN`. The validation
 *    contract requires 401 for credential failures; the translator
 *    rewrites only responses for requests that actually carried an
 *    api key, so a cookie-only 403 from the origin middleware (a CSRF
 *    rejection, semantically different) is left alone.
 *
 * 2. A get-session session-token redactor. When the request uses an
 *    api key, Better-Auth's apiKey plugin sets `session.token` to the
 *    raw api key value (so the synthetic session is identifiable).
 *    Echoing that field in `/api/auth/get-session` would leak the
 *    credential. The redactor rewrites the JSON body so `session.token`
 *    is replaced with an opaque placeholder when (and only when) it
 *    matches the api key the client presented.
 */

interface AuthMountOptions {
	auth: ReturnType<typeof betterAuth>
}

/**
 * Returns a Hono sub-app that owns `/api/auth/*`. The caller is expected
 * to mount it on the registry's main `Hono` instance via
 * `app.route("/", authApp)`.
 */
export function createAuthMount(options: AuthMountOptions): Hono {
	const { auth } = options
	const app = new Hono()

	app.use("/api/auth/*", async (c, next) => {
		const presentedApiKey = c.req.header("x-api-key")
		await next()
		if (!presentedApiKey) return
		if (c.res?.status === 403) {
			c.res = new Response(JSON.stringify({ error: "authentication required" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			})
			return
		}
		if (c.res?.status !== 200) return
		// Only redact get-session (the only endpoint that echoes session.token).
		// Other 200 responses (api-key/list, api-key/get) already strip the
		// hashed `key` column server-side; re-parsing them here would be
		// wasted work.
		const path = new URL(c.req.url).pathname
		if (!path.endsWith("/api/auth/get-session")) return
		const cloned = c.res.clone()
		const text = await cloned.text()
		try {
			const body = JSON.parse(text) as { session?: { token?: unknown } } | null
			if (body?.session && body.session.token === presentedApiKey) {
				c.res = new Response(JSON.stringify({ ...body, session: { ...body.session, token: null } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			}
		} catch {
			// Non-JSON body — leave it alone.
		}
	})

	app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
	return app
}
