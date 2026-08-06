import type { betterAuth } from "better-auth"
import { Hono } from "hono"

/**
 * Org/member management endpoints (architecture §4.4, validation contract
 * VAL-AUTH-005 / 006 / 007 / 008).
 *
 * The registry surface lives at `/v1/orgs/*`; the underlying
 * Better-Auth organization plugin lives at `/api/auth/organization/*`
 * with role enforcement (owner / admin / member) baked into the
 * plugin's ACL. Each route below:
 *   1. Resolves the `:slug` URL parameter to the org's UUID via
 *      Better-Auth's full-organization lookup (which honors the caller's
 *      membership — outsiders get 404, never the org id).
 *   2. Forwards the request to the Better-Auth handler with the
 *      translated path and body. Better-Auth returns the result
 *      unchanged; the registry does not invent any new business logic.
 *   3. Normalizes the response envelope so an unauthenticated request
 *      returns `{error: "..."}` (the auth feature's contract shape)
 *      rather than Better-Auth's `{message: "..."}`.
 *
 * The `auth.api.*` callable form is used for the slug-to-org-id lookup
 * (which is a single private call) instead of an HTTP forward. The
 * forwarded routes use the `auth.handler` so the apiKey plugin's
 * rate-limit counter increments exactly once per request — pre-checking
 * the identity here would double-count and trip the per-key ceiling
 * (10 requests per 24h default for the apiKey plugin).
 */

interface OrgRoutesDeps {
	auth: ReturnType<typeof betterAuth>
}

export function createOrgRoutes(deps: OrgRoutesDeps): Hono {
	const { auth } = deps
	const app = new Hono()

	// POST /v1/orgs → POST /api/auth/organization/create
	app.post("/v1/orgs", async (c) => {
		const incomingBody = await readBody(c.req.raw)
		const body = { ...incomingBody, userId: incomingBody.userId }
		const response = await forwardToAuth(c, auth, "/api/auth/organization/create", body, "POST")
		return normalizeAuthResponse(c, response)
	})

	// GET /v1/orgs → GET /api/auth/organization/list
	app.get("/v1/orgs", async (c) => {
		const response = await forwardToAuth(c, auth, "/api/auth/organization/list", null, "GET")
		return normalizeAuthResponse(c, response)
	})

	// POST /v1/orgs/:slug/invite → POST /api/auth/organization/invite-member
	app.post("/v1/orgs/:slug/invite", async (c) => {
		const slug = c.req.param("slug")
		const lookup = await findOrgIdBySlug(auth, c.req.raw, slug)
		if ("response" in lookup) return lookup.response
		const incomingBody = await readBody(c.req.raw)
		const body = { ...incomingBody, organizationId: lookup.id }
		const response = await forwardToAuth(c, auth, "/api/auth/organization/invite-member", body, "POST")
		return normalizeAuthResponse(c, response)
	})

	// POST /v1/orgs/:slug/accept-invitation → POST /api/auth/organization/accept-invitation
	app.post("/v1/orgs/:slug/accept-invitation", async (c) => {
		const body = await readBody(c.req.raw)
		const response = await forwardToAuth(c, auth, "/api/auth/organization/accept-invitation", body, "POST")
		return normalizeAuthResponse(c, response)
	})

	// GET /v1/orgs/:slug/members → GET /api/auth/organization/list-members?organizationSlug=...
	app.get("/v1/orgs/:slug/members", async (c) => {
		const slug = c.req.param("slug")
		const url = new URL(c.req.url)
		url.pathname = "/api/auth/organization/list-members"
		url.search = ""
		url.searchParams.set("organizationSlug", slug)
		const newReq = new Request(url.toString(), {
			method: "GET",
			headers: c.req.raw.headers,
		})
		const response = await auth.handler(newReq)
		return normalizeAuthResponse(c, response)
	})

	// POST /v1/orgs/:slug/update-member-role → POST /api/auth/organization/update-member-role
	app.post("/v1/orgs/:slug/update-member-role", async (c) => {
		const slug = c.req.param("slug")
		const lookup = await findOrgIdBySlug(auth, c.req.raw, slug)
		if ("response" in lookup) return lookup.response
		const incomingBody = await readBody(c.req.raw)
		const body = { ...incomingBody, organizationId: lookup.id }
		const response = await forwardToAuth(c, auth, "/api/auth/organization/update-member-role", body, "POST")
		return normalizeAuthResponse(c, response)
	})

	// DELETE /v1/orgs/:slug → POST /api/auth/organization/delete (owner-only)
	app.delete("/v1/orgs/:slug", async (c) => {
		const slug = c.req.param("slug")
		const lookup = await findOrgIdBySlug(auth, c.req.raw, slug)
		if ("response" in lookup) return lookup.response
		const body = { organizationId: lookup.id }
		// DELETE has no body semantics for the underlying plugin, so we
		// POST the delete body and let Better-Auth handle the auth.
		const response = await forwardToAuth(c, auth, "/api/auth/organization/delete", body, "POST")
		return normalizeAuthResponse(c, response)
	})

	return app
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Reads the body of a request as a JSON object. Returns an empty object
 * when the body is empty or unreadable. The body is consumed exactly once
 * and the result is suitable for re-serialization into a new Request.
 */
async function readBody(request: Request): Promise<Record<string, unknown>> {
	const cloned = request.clone()
	const text = await cloned.text()
	if (text.length === 0) return {}
	try {
		return JSON.parse(text) as Record<string, unknown>
	} catch {
		return {}
	}
}

/**
 * Forwards the request to a Better-Auth endpoint with the given body.
 * The URL is rewritten to `authPath`; the headers (including the api
 * key / cookie credential) are forwarded untouched. The body is
 * re-serialized from the `body` argument.
 */
async function forwardToAuth(
	c: { req: { raw: Request; url: string } },
	auth: ReturnType<typeof betterAuth>,
	authPath: string,
	body: Record<string, unknown> | null,
	method: "POST" | "GET",
): Promise<Response> {
	const url = new URL(c.req.url)
	url.pathname = authPath
	url.search = ""
	const init: RequestInit = {
		method,
		headers: c.req.raw.headers,
	}
	if (body !== null) {
		init.body = JSON.stringify(body)
	}
	const newReq = new Request(url.toString(), init)
	return auth.handler(newReq)
}

/**
 * Normalizes the response envelope so an unauthenticated request
 * returns `{error: "..."}` (the auth feature's contract shape) rather
 * than Better-Auth's `{message: "..."}` envelope.
 *
 * Translation rules:
 *   - 401 (Better-Auth session middleware): becomes a 401 envelope
 *     with the existing message extracted.
 *   - 403 with an `x-api-key` header AND a body code matching the
 *     apiKey plugin's "INVALID_API_KEY" or "MISSING_API_KEY" / "key
 *     revoked" codes: becomes a 401 envelope. The apiKey plugin
 *     rejects invalid keys with 403; the contract requires the
 *     api-key surface to be honestly distinct from the cookie
 *     surface (invalid cookie = 401, invalid api-key = 401, origin
 *     or role failures on a valid api-key = 403). The `/api/auth/*`
 *     mount in `handlers.ts` enforces the same rule; the org surface
 *     mirrors it so role/permission 403s are not flattened to 401.
 *   - Other 403s (role enforcement, origin failures, etc.) and any
 *     404/409: passed through verbatim.
 *   - Other 4xx and 2xx: passed through verbatim.
 */
async function normalizeAuthResponse(c: { req: { raw: Request } }, response: Response): Promise<Response> {
	const presentedApiKey = c.req.raw.headers.get("x-api-key")
	const is401 = response.status === 401
	const isInvalidApiKey = response.status === 403 && Boolean(presentedApiKey)
	if (isInvalidApiKey) {
		const code = await extractResponseCode(response)
		if (!isCredentialRejectionCode(code)) return response
	}
	if (!is401 && !isInvalidApiKey) return response
	let message = "authentication required"
	const contentType = response.headers.get("content-type") ?? ""
	if (contentType.includes("application/json")) {
		try {
			const cloned = response.clone()
			const text = await cloned.text()
			if (text.length > 0) {
				const body = JSON.parse(text) as { message?: string; code?: string; error?: string }
				if (body.error && body.error.length > 0) message = body.error
				else if (body.message && body.message.length > 0) message = body.message
			}
		} catch {
			// Keep the canonical message when the body is not parseable.
		}
	}
	return new Response(JSON.stringify({ error: message }), {
		status: 401,
		headers: { "content-type": "application/json" },
	})
}

/**
 * Returns the Better-Auth error `code` if the response carries one.
 * Reads the body as text so a parse failure (empty body, non-JSON)
 * is treated as "no code" without throwing.
 */
async function extractResponseCode(response: Response): Promise<string | undefined> {
	const contentType = response.headers.get("content-type") ?? ""
	if (!contentType.includes("application/json")) return undefined
	try {
		const text = await response.clone().text()
		if (text.length === 0) return undefined
		const body = JSON.parse(text) as { code?: string; message?: string }
		return body.code ?? undefined
	} catch {
		return undefined
	}
}

/**
 * The Better-Auth apiKey plugin rejects invalid keys with a few
 * distinct status codes / bodies. Anything else on a 403 (e.g.
 * `FORBIDDEN` from `createAccessControl`) is a permission decision,
 * not a credential failure, and must stay 403.
 */
function isCredentialRejectionCode(code: string | undefined): boolean {
	if (code === undefined) return false
	return (
		code === "INVALID_API_KEY" ||
		code === "MISSING_API_KEY" ||
		code === "INVALID_OR_REVOKED_API_KEY" ||
		code === "API_KEY_DISABLED" ||
		code === "UNAUTHORIZED"
	)
}

type OrgIdLookup = { id: string } | { response: Response }

/**
 * Resolves a slug to the org's UUID via Better-Auth's full-organization
 * endpoint. The lookup honors the caller's membership: an outsider
 * receives a 404 (existence is not leaked), and the role enforcement
 * downstream will reject them anyway.
 *
 * An unauthenticated request throws 401 from Better-Auth's session
 * middleware. That is propagated as an honest 401 envelope so the
 * auth-gating contract (VAL-AUTH-002) holds for routes that go
 * through slug resolution; the auth state for the actual mutation
 * is reverified by Better-Auth when the forwarded request lands.
 *
 * The apiKey plugin's rate-limit counter increments once per session
 * lookup. The forward step that follows does the same — `findOrgIdBySlug`
 * is the only place we run an extra session lookup, so the cost is
 * at most one extra counter increment per state-changing route.
 */
async function findOrgIdBySlug(
	auth: ReturnType<typeof betterAuth>,
	request: Request,
	slug: string,
): Promise<OrgIdLookup> {
	const headers = headersToRecord(request.headers)
	const authAny = auth as unknown as {
		api: {
			getFullOrganization: (args: {
				query: { organizationSlug: string }
				headers: Record<string, string>
				asResponse: false
			}) => Promise<{ id: string } | null>
		}
	}
	try {
		const org = await authAny.api.getFullOrganization({
			query: { organizationSlug: slug },
			headers,
			asResponse: false,
		})
		if (!org || typeof org.id !== "string") {
			return notFoundJson()
		}
		return { id: org.id }
	} catch (err) {
		// Better-Auth throws APIError with `.statusCode` when the
		// session middleware rejects the request. Propagate the 401
		// so the contract's 401 envelope is honored; collapse every
		// other failure to 404 (no existence leak).
		const status = (err as { statusCode?: number; status?: number } | null)?.statusCode
		if (status === 401 || status === 403) {
			return {
				response: new Response(JSON.stringify({ error: "authentication required" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			}
		}
		return notFoundJson()
	}
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [name, value] of headers.entries()) {
		out[name.toLowerCase()] = value
	}
	return out
}

function notFoundJson(): { response: Response } {
	return {
		response: new Response(JSON.stringify({ error: "organization not found" }), {
			status: 404,
			headers: { "content-type": "application/json" },
		}),
	}
}
