import type { PGlite } from "@electric-sql/pglite"
import type { betterAuth } from "better-auth"
import { Hono } from "hono"
import { createAuthMount } from "./auth/handlers"
import { createOrgRoutes } from "./auth/org-routes"
import { createAuthRoutes } from "./auth/stub-routes"
import { createCatalogRoutes } from "./catalog/routes"

/**
 * The registry HTTP app (architecture §4.1, §4.4).
 *
 * `buildApp(deps)` constructs the full Hono application with auth and
 * the database wired in. `server.ts` calls this at startup; tests call
 * it per-case with a fresh PGlite + Better-Auth pair.
 *
 * The default export is a minimal `Hono` instance with only the
 * `/healthz` route — it exists so pre-auth tests (and the binary's
 * pre-boot health probe) do not need a live database or auth instance.
 *
 * Routes wired by `buildApp`:
 *   - GET /healthz    (decision 10: liveness probe; always 200 + ok JSON)
 *   - /api/auth/*     (Better-Auth handler: GitHub OAuth, session
 *                      cookies, get-session, organization + api-key
 *                      plugin endpoints).
 *   - /v1/modules*, /v1/modules/:scope/:name[/...]
 *                      (catalog read paths, DB-backed, seeded from
 *                      BUILT_IN_CATALOG — feature: registry-catalog-read-paths).
 *   - /v1/publish     (auth-gated stub; the real publish flow lands in
 *                      the publishing-ingest milestone).
 *   - /v1/orgs/*      (org CRUD, membership, invitations, role
 *                      enforcement — feature: registry-orgs).
 *
 * Additional routes (publish metadata, screening, previews, etc.)
 * land in subsequent registry-core milestones and reuse the identity
 * resolver and visibility helpers from `auth/`.
 */

export interface AppDeps {
	auth: ReturnType<typeof betterAuth>
	pglite: PGlite
}

/**
 * Builds the Hono app. The auth and database dependencies are injected
 * so tests can swap a fresh PGlite + Better-Auth per case without going
 * through the listener bootstrap.
 */
export function buildApp(deps: AppDeps): Hono {
	const app = new Hono()

	app.get("/healthz", (c) => c.json({ status: "ok" }))

	// Better-Auth's single Fetch-API handler covers every /api/auth/*
	// route (sign-in, callback, get-session, sign-out, organization
	// CRUD, api-key CRUD, etc.).
	const authApp = createAuthMount({ auth: deps.auth })
	app.route("/", authApp)

	// Auth-aware endpoints: visibility reads + auth-gated writes.
	const authRoutes = createAuthRoutes({ auth: deps.auth, pglite: deps.pglite })
	app.route("/", authRoutes)

	// Catalog read paths (DB-backed, seeded from BUILT_IN_CATALOG):
	//   GET  /v1/modules[?tier=...]
	//   GET  /v1/modules/:scope/:name
	//   GET  /v1/modules/:scope/:name/versions
	//   GET  /v1/modules/:scope/:name/:version
	// All responses carry Cache-Control: no-store (decision 25).
	const catalogRoutes = createCatalogRoutes({ auth: deps.auth, pglite: deps.pglite })
	app.route("/", catalogRoutes)

	// Org management: create, list, invite, accept, list members,
	// role change, delete. Each route proxies to the Better-Auth
	// organization plugin so role enforcement lives in one place.
	const orgRoutes = createOrgRoutes({ auth: deps.auth, pglite: deps.pglite })
	app.route("/", orgRoutes)

	return app
}

const app = new Hono()

app.get("/healthz", (c) => c.json({ status: "ok" }))

export default app
