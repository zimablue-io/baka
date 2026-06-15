import { Hono } from "hono"
import { fetchCatalog } from "../lib/fetch-catalog"
import { getBuiltInCatalog } from "../lib/load-data"
import type { ApiModuleEntry } from "../lib/schema"
import { tierForCatalog } from "../lib/tier"
import { catalogCache } from "./aggregate"

/**
 * GET /v1/modules/:name
 *
 * Looks up a single module by name across the built-in catalog and a
 * caller-supplied list of community/verified catalog URLs.
 *
 * Resolution order (deterministic):
 *   1. The built-in catalog (no fetch required). Wins on any match.
 *   2. The URLs in `?catalogs=...`, in the order the caller provided them.
 *      The caller is expected to put verified URLs first; on a same-tier
 *      tie, the first match in the input order wins (also a documented
 *      contract for the CLI).
 *
 * Response: `{ module, source: { catalog, tier } }` or 404.
 *
 * Reuses the same per-URL `catalogCache` as `/v1/aggregate` so an upstream
 * fetch is shared across endpoints within the 5-minute window.
 */

const route = new Hono()

function withBuiltInTier(): ApiModuleEntry[] {
	return getBuiltInCatalog().modules.map((m) => ({ ...m, tier: "built-in" as const }))
}

route.get("/v1/modules/:name", async (c) => {
	const name = c.req.param("name")

	// 1. Built-in catalog (in-process; no fetch).
	for (const m of withBuiltInTier()) {
		if (m.name === name) {
			c.header("Cache-Control", "public, max-age=300")
			return c.json({
				module: m,
				source: { catalog: "(built-in)", tier: "built-in" as const },
			})
		}
	}

	// 2. Caller-supplied catalogs in the order provided.
	const urls = c.req.queries("catalogs") ?? []
	for (const url of urls) {
		let catalog = catalogCache.get(url)
		if (!catalog) {
			try {
				catalog = await fetchCatalog(url, { timeoutMs: 5000 })
				catalogCache.set(url, catalog)
			} catch {
				// Skip unreachable / invalid catalogs and try the next one.
				continue
			}
		}
		const found = catalog.modules.find((m) => m.name === name)
		if (found) {
			const tier = tierForCatalog(url)
			c.header("Cache-Control", "public, max-age=300")
			return c.json({
				module: { ...found, tier },
				source: { catalog: url, tier },
			})
		}
	}

	return c.json({ error: `module not found: ${name}` }, 404)
})

export default route
