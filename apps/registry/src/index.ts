import { Hono } from "hono"

/**
 * The registry HTTP app (architecture §4.1).
 *
 * This is the Hono application that serves the registry API. It is exported
 * separately from the listener bootstrap so tests can drive it directly
 * with `app.request(...)` without binding a real port.
 *
 * Routes wired in this milestone:
 *   - GET /healthz    (decision 10: liveness probe; always 200 + ok JSON)
 *
 * Additional routes (publish, catalog, screening, etc.) land in
 * subsequent registry-core milestones.
 */

const app = new Hono()

app.get("/healthz", (c) => c.json({ status: "ok" }))

export default app
