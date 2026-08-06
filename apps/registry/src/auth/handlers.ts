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
	app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
	return app
}
