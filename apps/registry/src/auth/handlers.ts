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
 *    header and Better-Auth rejects it with a credential-rejection
 *    error code (the apiKey plugin's INVALID_API_KEY / MISSING_API_KEY /
 *    INVALID_OR_REVOKED_API_KEY / API_KEY_DISABLED / UNAUTHORIZED codes),
 *    the response is rewritten to 401. The code-checking matters because
 *    a blanket 403→401 rewrite would mask legitimate authorization
 *    failures (role 403s, origin 403s) that the contract requires to
 *    pass through as 403 — see AGENTS.md "403→401 translation uses
 *    code-checking, not blanket rewrites". A cookie-only 403 from the
 *    origin middleware (a CSRF rejection, semantically different) is
 *    also left alone because no api key was presented.
 *
 * 2. A get-session session-token redactor. When the request uses an
 *    api key, Better-Auth's apiKey plugin sets `session.token` to the
 *    raw api key value (so the synthetic session is identifiable).
 *    Echoing that field in `/api/auth/get-session` would leak the
 *    credential. The redactor rewrites the JSON body so `session.token`
 *    is replaced with an opaque placeholder when (and only when) it
 *    matches the api key the client presented.
 */

/**
 * Better-Auth apiKey-plugin error codes that mean "the credential was
 * rejected" (as opposed to a permission decision). Mirrors
 * `isCredentialRejectionCode` in `org-routes.ts` — the two surfaces
 * MUST agree on what counts as a credential failure, otherwise a
 * malformed api key gets a 401 here and the same key's downstream
 * mutation gets a 403 from the org route (or vice versa).
 */
const API_KEY_CREDENTIAL_REJECTION_CODES = new Set<string>([
	"INVALID_API_KEY",
	"MISSING_API_KEY",
	"INVALID_OR_REVOKED_API_KEY",
	"API_KEY_DISABLED",
	"UNAUTHORIZED",
])

/**
 * Returns the Better-Auth `code` field from a response body without
 * throwing on parse failure. Empty / non-JSON bodies return undefined
 * so the caller can fall through to the 403-pass-through branch.
 */
async function extractErrorCode(response: Response): Promise<string | undefined> {
	const contentType = response.headers.get("content-type") ?? ""
	if (!contentType.includes("application/json")) return undefined
	try {
		const text = await response.clone().text()
		if (text.length === 0) return undefined
		const body = JSON.parse(text) as { code?: unknown }
		if (typeof body.code === "string") return body.code
		return undefined
	} catch {
		return undefined
	}
}

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
		// Credential failures (api-key plugin rejected the presented key):
		// the request really did fail authentication, so 401 is the honest
		// answer. Anything else on a 403 (role enforcement, origin
		// middleware, membership check) is a permission decision and MUST
		// pass through as 403 — the validation contract distinguishes the
		// two surfaces and a blanket rewrite would mask role failures
		// (AGENTS.md: 403→401 translation uses code-checking, not blanket
		// rewrites).
		if (c.res?.status === 403) {
			const code = await extractErrorCode(c.res)
			if (code === undefined || !API_KEY_CREDENTIAL_REJECTION_CODES.has(code)) return
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
