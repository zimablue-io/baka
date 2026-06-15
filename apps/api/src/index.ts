import { Hono } from "hono"
import aggregateRoute from "./routes/aggregate"
import builtInRoute from "./routes/built-in"
import modulesRoute from "./routes/modules"
import verifiedRoute from "./routes/verified"

/**
 * Baka marketplace API. Served on Vercel Edge Functions.
 *
 * Surface (v1):
 *   GET  /v1/built-in                  - the first-party catalog
 *   GET  /v1/built-in/:moduleName      - one built-in module
 *   GET  /v1/verified                  - the list of verified community catalogs
 *   POST /v1/aggregate                 - merge modules from a list of catalog URLs
 *   GET  /v1/modules/:name             - look up a module name across catalogs
 *   GET  /healthz                      - liveness probe
 *
 * The app is stateless: data lives in `src/data/*.json` (built-in and
 * verified), and community catalogs are fetched on demand. A tiny in-memory
 * cache (see `lib/cache.ts`) absorbs hot-path traffic without a DB.
 *
 * Vercel Edge expects a default-exported handler that exposes `fetch`. A
 * Hono app satisfies this directly.
 */
const app = new Hono()

app.get("/healthz", (c) => c.json({ status: "ok" }))

app.route("/", builtInRoute)
app.route("/", verifiedRoute)
app.route("/", aggregateRoute)
app.route("/", modulesRoute)

export default app
