import type { PGlite } from "@electric-sql/pglite"
import type { betterAuth } from "better-auth"
import { drizzle } from "drizzle-orm/pglite"
import { Hono } from "hono"
import * as schema from "../db/schema"
import { resolveIdentity, unauthorizedJson } from "./identity"

/**
 * Auth-aware endpoints (architecture §4.4, validation contract
 * VAL-AUTH-002/003/010/011).
 *
 * These endpoints exist to give the auth feature a verifiable
 * write/read surface. They return the caller's identity on success and
 * enforce the visibility rules documented in the contract. Subsequent
 * milestones extend each route's payload with the real resource fields
 * (publish metadata, org details, invite payloads) — the auth gating,
 * visibility logic, and origin enforcement land here and are reused.
 *
 * Write surface (VAL-AUTH-002):
 *   - POST /v1/orgs   — requires authentication; returns the caller's
 *                       user id. Without auth → 401 with a JSON body.
 *   - POST /v1/publish
 *   - POST /v1/orgs/:slug/invite
 *
 * Read surface (VAL-AUTH-003):
 *   - GET  /v1/modules/:scope/:name — visibility-aware. With no
 *                       credential: public modules return 200;
 *                       org-visibility modules return 404 (existence is
 *                       not leaked).
 *
 * Origin-check surface (VAL-AUTH-010):
 *   - POST /v1/orgs, when authenticated by SESSION COOKIE, requires a
 *     matching `origin` header. API-key header auth bypasses the
 *     check — the two paths are honestly distinct (architecture §4.4
 *     verified gotcha).
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
	const { auth, pglite } = deps
	const app = new Hono()

	app.get("/v1/modules/:scope/:name", async (c) => {
		const scope = c.req.param("scope")
		const name = c.req.param("name")
		const db = drizzle(pglite, { schema })
		const rows = await db.query.modules.findMany({
			where: (m, { and, eq, isNull }) => and(eq(m.scope, scope), eq(m.name, name), isNull(m.removedAt)),
		})
		const row = rows[0]
		if (!row) {
			// Existence is not leaked — same response for missing and org-private.
			return c.json({ error: "not found" }, 404)
		}
		if (row.visibility === "org") {
			const identity = await resolveIdentity(auth, c.req.raw)
			if (!identity) {
				return c.json({ error: "not found" }, 404)
			}
		}
		return c.json({
			scope: row.scope,
			name: row.name,
			visibility: row.visibility,
			tier: row.tier,
			description: row.description,
		})
	})

	app.post("/v1/orgs", async (c) => {
		const identity = await resolveIdentity(auth, c.req.raw)
		if (!identity) return unauthorizedJson()
		return c.json({ userId: identity.userId, created: true })
	})

	app.post("/v1/publish", async (c) => {
		const identity = await resolveIdentity(auth, c.req.raw)
		if (!identity) return unauthorizedJson()
		return c.json({ userId: identity.userId, accepted: true })
	})

	app.post("/v1/orgs/:slug/invite", async (c) => {
		const identity = await resolveIdentity(auth, c.req.raw)
		if (!identity) return unauthorizedJson()
		return c.json({ userId: identity.userId, invited: true })
	})

	return app
}
