import type { PGlite } from "@electric-sql/pglite"
import type { betterAuth } from "better-auth"
import { Hono } from "hono"
import { createAuthMount } from "./auth/handlers"
import { createOrgRoutes } from "./auth/org-routes"
import { createCatalogRoutes } from "./catalog/routes"
import { createPublishRoutes } from "./publish/routes"
import type { StorageAdapter } from "./storage"

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
 *                      BUILT_IN_CATALOG — feature: registry-catalog-read-paths;
 *                      list endpoint filters by visibility).
 *   - /v1/publish     (request validation, role + plan-limit gate,
 *                      pending row creation, worker enqueue —
 *                      feature: publish-endpoint + ingest-worker).
 *   - /v1/orgs/*      (org CRUD, membership, invitations, role
 *                      enforcement — feature: registry-orgs).
 *
 * Additional routes (screening/preview pipeline, unpublish, etc.)
 * land in subsequent publishing-ingest milestones and reuse the
 * identity resolver, plan-limit helper, and visibility filter from
 * `auth/` and `catalog/`.
 */

export interface AppDeps {
	auth: ReturnType<typeof betterAuth>
	pglite: PGlite
	/**
	 * The slug of the official org (architecture §8 decision 26).
	 * Publish route uses it to resolve bare-name scoping at ingest
	 * time (deferred to the worker); the value is passed through so
	 * the seam is wired in this milestone.
	 */
	officialOrg?: string
	/**
	 * Optional enqueue seam for the ingest worker (architecture §4.5).
	 * The publish endpoint calls this with the freshly-created
	 * `module_versions.id`. With the polling-loop worker the seam is
	 * purely a hint — the worker discovers rows by polling
	 * `module_versions.status='pending'` regardless (decision 35);
	 * the call exists so tests can observe "publish signaled a new
	 * row" through a simple counter.
	 */
	enqueueIngest?: (versionId: string) => Promise<void>
	/**
	 * Optional storage adapter for the tarball download endpoint
	 * (VAL-PUB-007). When unset, GET /v1/download/* returns 503
	 * (server-side configuration missing, not a client error).
	 */
	storage?: StorageAdapter
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

	// Catalog read paths (DB-backed, seeded from BUILT_IN_CATALOG):
	//   GET  /v1/modules[?tier=...]
	//   GET  /v1/modules/:scope/:name
	//   GET  /v1/modules/:scope/:name/versions
	//   GET  /v1/modules/:scope/:name/:version
	// All responses carry Cache-Control: no-store (decision 25).
	// The list endpoint applies a visibility WHERE clause so
	// org-visibility modules are hidden from callers without
	// proven org membership (VAL-AUTH-003, VAL-PUB-016).
	const catalogRoutes = createCatalogRoutes({
		auth: deps.auth,
		pglite: deps.pglite,
		storage: deps.storage,
	})
	app.route("/", catalogRoutes)

	// Publish endpoint (architecture §4.5, decision 30):
	//   POST /v1/publish — request validation, role enforcement,
	//                       plan-limit gate, pending row creation,
	//                       worker enqueue (ingest-worker feature).
	const publishRoutes = createPublishRoutes({
		auth: deps.auth,
		pglite: deps.pglite,
		officialOrg: deps.officialOrg ?? "baka",
		enqueueIngest: deps.enqueueIngest,
	})
	app.route("/", publishRoutes)

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
