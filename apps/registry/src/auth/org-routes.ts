import type { PGlite } from "@electric-sql/pglite"
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
	pglite: PGlite
}

export function createOrgRoutes(deps: OrgRoutesDeps): Hono {
	const { auth, pglite } = deps
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
		const enriched = await enrichOrgListWithRole(c, auth, pglite, response)
		return normalizeAuthResponse(c, enriched)
	})

	// PATCH /v1/orgs/:slug → POST /api/auth/organization/update.
	// The registry pre-validates the body before forwarding; unknown
	// fields (e.g. `plan`, which the contract forbids on this surface
	// per VAL-AUTH-017) are rejected with a 4xx JSON envelope rather
	// than forwarded, because the Better-Auth path strips unknown
	// fields and would otherwise produce an empty UPDATE clause —
	// Postgres' syntax error (code 42601) leaks through as a 500 with
	// an empty body, violating the uniform 4xx-error contract.
	app.patch("/v1/orgs/:slug", async (c) => {
		const slug = c.req.param("slug")
		const lookup = await findOrgIdBySlug(auth, c.req.raw, slug)
		if ("response" in lookup) return lookup.response
		const incomingBody = await readBody(c.req.raw)
		const validation = validateOrgUpdateBody(incomingBody)
		if (validation.kind === "error") {
			return new Response(JSON.stringify(validation.error), {
				status: validation.status,
				headers: { "content-type": "application/json" },
			})
		}
		const body = { ...validation.body, organizationId: lookup.id }
		const response = await forwardToAuth(c, auth, "/api/auth/organization/update", body, "POST")
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
		const lookup = await findOrgIdBySlug(auth, c.req.raw, slug)
		if ("response" in lookup) return lookup.response
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

	// DELETE /v1/orgs/:slug → POST /api/auth/organization/delete (owner-only).
	// The registry-side check (architecture §8 decision 2, VAL-AUTH-016)
	// refuses to delete an org that owns any non-tombstoned modules; the
	// response names the block. When the org is empty, the request is
	// forwarded to Better-Auth, which handles owner-only enforcement and
	// cascades members / invitations (VAL-AUTH-015).
	app.delete("/v1/orgs/:slug", async (c) => {
		const slug = c.req.param("slug")
		const lookup = await findOrgIdBySlug(auth, c.req.raw, slug)
		if ("response" in lookup) return lookup.response
		const ownsModules = await countOrgModules(pglite, slug)
		if (ownsModules > 0) {
			return c.json(
				{
					error: `organization '${slug}' cannot be deleted because it owns ${ownsModules} published module(s); unpublish them first`,
					scope: slug,
					modulesOwned: ownsModules,
				},
				409,
			)
		}
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
 *
 * When the caller supplies a JSON body but the original request did
 * NOT carry `content-type: application/json` (e.g. a DELETE that this
 * handler turns into a POST with a server-built body), we explicitly
 * set `content-type: application/json` on the forwarded request —
 * Better-Auth's router returns 415 Unsupported Media Type otherwise.
 * The original headers are preserved so cookies / api keys still pass
 * through; only the missing content-type header is added.
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
	const headers = new Headers(c.req.raw.headers)
	if (body !== null) {
		headers.set("content-type", "application/json")
	}
	const init: RequestInit = {
		method,
		headers,
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
		// Better-Auth throws APIError with `.statusCode` for any
		// authorization or server-side rejection. The contract
		// distinguishes them:
		//
		//   - 401 (Better-Auth session middleware refused the
		//     request — no credential or invalid credential). The
		//     request really did lack authentication; the 401
		//     envelope is honest.
		//   - 403 with a credential-rejection body code
		//     (`INVALID_API_KEY` / `MISSING_API_KEY` /
		//     `INVALID_OR_REVOKED_API_KEY` / `API_KEY_DISABLED` /
		//     `UNAUTHORIZED` — see `isCredentialRejectionCode`):
		//     this is the apiKey plugin's `FORBIDDEN`, not a
		//     permission decision. A request that presented an
		//     `x-api-key` and got rejected must be told
		//     "authentication required" (the api-key path is
		//     honestly distinct from the cookie path; this is the
		//     same translation `handlers.ts` performs for
		//     `/api/auth/*`).
		//   - 403 with any other body — Better-Auth's
		//     `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` from a
		//     membership check, or a role/permission 403 from
		//     downstream — must NOT leak existence. Translate to
		//     404 (matches catalog detail-endpoint convention;
		//     `apps/registry/src/catalog/routes.ts`).
		//   - Anything else — non-existent slug, downstream DB
		//     hiccup, malformed response — also becomes 404 to keep
		//     the existence-leak guarantee uniform.
		const status = (err as { statusCode?: number; status?: number } | null)?.statusCode
		if (status === 401) {
			return unauthorizedJson()
		}
		if (status === 403) {
			const code = extractApiErrorCode(err)
			if (isCredentialRejectionCode(code)) {
				return unauthorizedJson()
			}
		}
		return notFoundJson()
	}
}

/**
 * Canonical 401 envelope — shared between the slug lookup (where the
 * session middleware refuses) and the route-level `auth required`
 * check so every unauthenticated registry response has the same shape
 * (`{"error":"authentication required"}`).
 */
function unauthorizedJson(): { response: Response } {
	return {
		response: new Response(JSON.stringify({ error: "authentication required" }), {
			status: 401,
			headers: { "content-type": "application/json" },
		}),
	}
}

/**
 * Extracts the APIError `code` field from a Better-Auth thrown value
 * without surfacing the body to callers. Better-Auth's APIError
 * shape is `{ statusCode, body: { code, message } }`; older builds
 * have thrown values that only carry `.status` — both are tolerated.
 *
 * Returns `undefined` for anything that is not an APIError so the
 * caller's `isCredentialRejectionCode(undefined) === false` branch
 * keeps its non-leak meaning.
 */
function extractApiErrorCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined
	const code = (err as { body?: { code?: unknown } }).body?.code
	if (typeof code === "string") return code
	// Some Better-Auth paths throw objects that put `code` directly
	// on the error (older builds). Mirror that fallback.
	const flatCode = (err as { code?: unknown }).code
	if (typeof flatCode === "string") return flatCode
	return undefined
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

/**
 * Counts the non-tombstoned modules under a given org slug. Used by
 * the DELETE handler to enforce "orgs that own published modules
 * cannot be deleted" (architecture §8 decision 2, VAL-AUTH-016).
 * Public and org-visibility modules both count; removed_at IS NULL
 * excludes tombstoned modules so an unpublished module does not
 * forever block its org's deletion.
 */
async function countOrgModules(pglite: PGlite, slug: string): Promise<number> {
	const result = await pglite.query<{ count: string }>(
		`SELECT COUNT(*)::text AS count
		   FROM modules
		  WHERE scope = $1
		    AND removed_at IS NULL`,
		[slug],
	)
	return Number.parseInt(result.rows[0]?.count ?? "0", 10)
}

/**
 * Fields the registry accepts on PATCH /v1/orgs/:slug. These are the
 * writable columns on Better-Auth's `organization` table that are not
 * security-sensitive (id, createdAt, and any role-related columns are
 * excluded). `metadata` is a jsonb blob the operator can use for
 * arbitrary key/value storage; `plan` is intentionally absent because
 * the registry locks that column to env-only seeding (VAL-AUTH-017).
 *
 * Anything outside this set is an honest 4xx — the contract forbids
 * forwarding unknown fields to Better-Auth because (a) the framework
 * silently strips them, masking what the caller attempted; and (b) an
 * `UPDATE ... SET` clause with no known columns after stripping
 * triggers a Postgres syntax error (42601) that leaks through as a
 * 500 with an empty body. Both are worse than rejecting the field
 * by name at the edge.
 */
const ORG_UPDATE_ALLOWED_FIELDS = new Set(["name", "slug", "logo", "metadata"] as const)

type OrgUpdateValidation =
	| { kind: "ok"; body: { data: Record<string, unknown> } }
	| { kind: "error"; status: number; error: { error: string; allowedFields: string[] } }

/**
 * Pre-validates the org-update body before forwarding to Better-Auth.
 * Returns a tagged result the caller pattern-matches on:
 *   - `kind: "ok"` → forward `{ data, organizationId }` to Better-Auth.
 *   - `kind: "error"` → return the 4xx envelope (never reaching the
 *     Better-Auth path that would otherwise 500 on empty SET).
 */
function validateOrgUpdateBody(input: Record<string, unknown>): OrgUpdateValidation {
	if (typeof input !== "object" || input === null) {
		return {
			kind: "error",
			status: 400,
			error: {
				error: "request body must be a JSON object",
				allowedFields: [...ORG_UPDATE_ALLOWED_FIELDS],
			},
		}
	}
	const dataField = (input as { data?: unknown }).data
	if (typeof dataField !== "object" || dataField === null || Array.isArray(dataField)) {
		return {
			kind: "error",
			status: 400,
			error: {
				error: 'organization update body must be wrapped in a `data` object (e.g. {"data": {"name": "..."}})',
				allowedFields: [...ORG_UPDATE_ALLOWED_FIELDS],
			},
		}
	}
	const data = dataField as Record<string, unknown>
	const provided = Object.keys(data)
	const unknownFields = provided.filter((k) => !ORG_UPDATE_ALLOWED_FIELDS.has(k as never))
	if (unknownFields.length > 0) {
		const first = unknownFields[0]
		if (first === undefined) {
			// Defensive: `Array.prototype.filter` only yields defined entries;
			// this branch is unreachable but keeps types narrow without `!`.
			return {
				kind: "error",
				status: 400,
				error: {
					error: "request body contained an unknown field",
					allowedFields: [...ORG_UPDATE_ALLOWED_FIELDS],
				},
			}
		}
		return {
			kind: "error",
			status: 400,
			error: {
				error:
					unknownFields.length === 1
						? `unknown field '${first}' in update body; allowed fields are: ${[...ORG_UPDATE_ALLOWED_FIELDS].join(", ")}`
						: `unknown fields [${unknownFields.join(", ")}] in update body; allowed fields are: ${[...ORG_UPDATE_ALLOWED_FIELDS].join(", ")}`,
				allowedFields: [...ORG_UPDATE_ALLOWED_FIELDS],
			},
		}
	}
	if (provided.length === 0) {
		return {
			kind: "error",
			status: 400,
			error: {
				error: `update body must change at least one field; allowed fields are: ${[...ORG_UPDATE_ALLOWED_FIELDS].join(", ")}`,
				allowedFields: [...ORG_UPDATE_ALLOWED_FIELDS],
			},
		}
	}
	return { kind: "ok", body: { data } }
}

/**
 * Enriches the Better-Auth `/organization/list` response with the
 * caller's role in each org, looked up directly from the `member`
 * table. Better-Auth's list endpoint returns org rows but never
 * includes `role` (the role lives on the membership); VAL-AUTH-006
 * demands the founder see `role: "owner"` without having to make a
 * second round trip to `/organization/list-members`.
 *
 * The enrichment runs ONLY when (a) the upstream response is 200
 * with a JSON array and (b) a credential-resolved userId is
 * available for the request. An empty result, non-200 upstream, or
 * unresolvable identity passes through unchanged — the contract is
 * additive, not destructive.
 */
async function enrichOrgListWithRole(
	c: { req: { raw: Request } },
	auth: ReturnType<typeof betterAuth>,
	pglite: PGlite,
	response: Response,
): Promise<Response> {
	if (response.status !== 200) return response
	const contentType = response.headers.get("content-type") ?? ""
	if (!contentType.includes("application/json")) return response

	let userId: string | null = null
	try {
		const identityAny = await resolveIdentityQuietly(auth, c.req.raw)
		if (identityAny) userId = identityAny.userId
	} catch {
		userId = null
	}
	if (userId === null) return response

	const cloned = response.clone()
	let upstream: unknown
	try {
		upstream = await cloned.json()
	} catch {
		return response
	}
	if (!Array.isArray(upstream) || upstream.length === 0) return response

	const orgIds: string[] = []
	for (const item of upstream) {
		if (typeof item === "object" && item !== null && "id" in item && typeof (item as { id: unknown }).id === "string") {
			orgIds.push((item as { id: string }).id)
		}
	}
	if (orgIds.length === 0) return response

	const rows = await pglite.query<{ organizationId: string; role: string }>(
		`SELECT "organizationId", role
		   FROM "member"
		  WHERE "userId" = $1
		    AND "organizationId" = ANY($2::text[])`,
		[userId, orgIds],
	)
	const roleByOrgId = new Map<string, string>()
	for (const row of rows.rows) {
		roleByOrgId.set(row.organizationId, row.role)
	}

	const enriched = upstream.map((item) => {
		if (typeof item !== "object" || item === null) return item
		const obj = item as Record<string, unknown>
		const id = obj.id
		if (typeof id !== "string") return item
		const role = roleByOrgId.get(id)
		if (role === undefined) return item
		return { ...obj, role }
	})

	return new Response(JSON.stringify(enriched), {
		status: response.status,
		headers: { "content-type": "application/json", ...responseHeadersPreservingCache(response) },
	})
}

/**
 * Copies forward the response headers that survived Better-Auth's
 * normalization (e.g. `cache-control: no-store`) so the enriched body
 * inherits the same caching policy the upstream set. Drops the
 * upstream `content-length` because the body shape changed.
 */
function responseHeadersPreservingCache(response: Response): Record<string, string> {
	const out: Record<string, string> = {}
	const cacheControl = response.headers.get("cache-control")
	if (cacheControl) out["cache-control"] = cacheControl
	return out
}

/**
 * Local copy of `resolveIdentity` that:
 *   - never throws (returns null on transport / parse errors)
 *   - only resolves to a non-null identity for credentials Better-Auth
 *     accepts (cookie or api-key)
 *   - does not echo the request body via the response chain (the
 *     enrichment path keeps `cache-control` and content-type, which
 *     avoids leaking cookies / keys into the next response).
 *
 * Defined as a small inline shim so the `enrich` helper stays
 * self-contained and doesn't pull the full `identity.ts` module
 * (which the registry already imports elsewhere via catalog routes).
 */
async function resolveIdentityQuietly(
	auth: ReturnType<typeof betterAuth>,
	request: Request,
): Promise<{ userId: string } | null> {
	const headers: Record<string, string | string[] | undefined> = {}
	for (const [name, value] of request.headers.entries()) {
		headers[name.toLowerCase()] = value
	}
	try {
		const result = await auth.api.getSession({
			headers: headers as unknown as Record<string, string>,
			asResponse: false,
		})
		if (!result) return null
		const userId = (result as { user?: { id?: unknown } }).user?.id
		if (typeof userId !== "string" || userId.length === 0) return null
		return { userId }
	} catch {
		return null
	}
}
