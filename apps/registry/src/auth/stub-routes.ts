import type { PGlite } from "@electric-sql/pglite"
import type { betterAuth } from "better-auth"
import { Hono } from "hono"
import { resolveIdentity, unauthorizedJson } from "./identity"

/**
 * Auth-aware endpoints (architecture §4.4, validation contract
 * VAL-AUTH-002/010/011).
 *
 * The org routes (`/v1/orgs/*`) moved to `org-routes.ts` as part of
 * the registry-orgs feature, and the catalog visibility read for
 * `/v1/modules/:scope/:name` moved to `catalog/routes.ts` (the
 * catalog-read-paths feature). What remains here is the auth-gated
 * publish stub, the identity resolver, and the canonical 401 envelope
 * shared by every write surface.
 *
 * Write surface (VAL-AUTH-002):
 *   - POST /v1/publish — auth-gated stub that returns the caller's
 *                       user id. The real publish flow lands in the
 *                       publishing-ingest milestone.
 *
 * Origin-check surface (VAL-AUTH-010):
 *   - POST /v1/publish, when authenticated by SESSION COOKIE, requires
 *                       a matching `origin` header. API-key header auth
 *                       bypasses the check — the two paths are honestly
 *                       distinct (architecture §4.4 verified gotcha).
 *
 * Identity-resolution surface (VAL-AUTH-011):
 *   - GET /api/auth/get-session resolves the caller identically whether
 *     the credential is a session cookie or an `x-api-key` header.
 */

interface AuthRouteDeps {
	auth: ReturnType<typeof betterAuth>
	pglite: PGlite
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono {
	const { auth } = deps
	const app = new Hono()

	app.post("/v1/publish", async (c) => {
		const identity = await resolveIdentity(auth, c.req.raw)
		if (!identity) return unauthorizedJson()
		return c.json({ userId: identity.userId, accepted: true })
	})

	return app
}
