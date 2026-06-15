import { Hono } from "hono"
import { getBuiltInCatalog } from "../lib/load-data"
import type { ApiCatalog, ApiModuleEntry } from "../lib/schema"

/**
 * Routes for the first-party catalog.
 *
 *   GET /v1/built-in              - the full catalog (with `tier: "built-in"`)
 *   GET /v1/built-in/:moduleName  - one module, or 404
 *
 * The `tier` field is server-attached. Publishers cannot self-declare it.
 * The cache-control header matches the spec (1h).
 */

function withTier(catalog: ReturnType<typeof getBuiltInCatalog>): ApiCatalog {
	return {
		...catalog,
		modules: catalog.modules.map((m): ApiModuleEntry => ({ ...m, tier: "built-in" })),
	}
}

const route = new Hono()

route.get("/v1/built-in", (c) => {
	const catalog = withTier(getBuiltInCatalog())
	c.header("Cache-Control", "public, max-age=3600")
	return c.json(catalog)
})

route.get("/v1/built-in/:moduleName", (c) => {
	const name = c.req.param("moduleName")
	const catalog = withTier(getBuiltInCatalog())
	const found = catalog.modules.find((m) => m.name === name)
	if (!found) return c.json({ error: `module not found: ${name}` }, 404)
	c.header("Cache-Control", "public, max-age=3600")
	return c.json(found)
})

export default route
