import { Hono } from "hono"
import { TTLCache } from "../lib/cache"
import { type FetchCatalogOptions, fetchCatalog } from "../lib/fetch-catalog"
import type { Catalog } from "../lib/schema"
import { AggregateRequestSchema, type AggregateResponse, type ApiModuleEntry } from "../lib/schema"
import { tierForCatalog } from "../lib/tier"

/**
 * POST /v1/aggregate
 *
 * Body: `{ catalogs: string[] }` (1-50 URLs)
 * Response: `{ modules: ApiModuleEntry[], catalogErrors: CatalogError[] }`
 *
 * Each catalog URL is fetched, validated, and its modules are tagged
 * with a server-attached `tier`:
 *   - URLs in `verified.json` -> "verified"
 *   - anything else          -> "community"
 *
 * Failed catalogs (HTTP error, parse error, schema mismatch) are
 * reported in `catalogErrors`; other catalogs still resolve. The
 * per-catalog fetch is cached for 5 minutes in-process; the aggregate
 * response itself is marked `Cache-Control: public, max-age=300` so
 * Vercel Edge and downstream CDNs can also cache it.
 */

const CACHE_TTL_MS = 5 * 60 * 1000
const catalogCache = new TTLCache<string, Catalog>(CACHE_TTL_MS)

const route = new Hono()

route.post("/v1/aggregate", async (c) => {
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return c.json({ error: "invalid JSON body" }, 400)
	}

	const parsed = AggregateRequestSchema.safeParse(raw)
	if (!parsed.success) {
		return c.json({ error: parsed.error.issues }, 400)
	}

	const urls = parsed.data.catalogs
	const fetchOptions: FetchCatalogOptions = { timeoutMs: 5000 }

	// Fetch in parallel; preserve URL order via index.
	const results = await Promise.allSettled(
		urls.map(async (url) => {
			const cached = catalogCache.get(url)
			if (cached) return { url, catalog: cached }
			const catalog = await fetchCatalog(url, fetchOptions)
			catalogCache.set(url, catalog)
			return { url, catalog }
		}),
	)

	const modules: ApiModuleEntry[] = []
	const catalogErrors: AggregateResponse["catalogErrors"] = []

	for (let i = 0; i < results.length; i++) {
		const result = results[i]
		const url = urls[i]
		if (result.status === "rejected") {
			const error = result.reason instanceof Error ? result.reason.message : String(result.reason)
			catalogErrors.push({ url, error })
			continue
		}
		const { catalog } = result.value
		const tier = tierForCatalog(url)
		for (const m of catalog.modules) {
			modules.push({ ...m, tier })
		}
	}

	c.header("Cache-Control", "public, max-age=300")
	return c.json({ modules, catalogErrors })
})

export { catalogCache }
export default route
