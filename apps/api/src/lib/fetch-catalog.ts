import { type Catalog, CatalogSchema } from "./schema"

/**
 * Fetches a catalog URL, validates the response against `CatalogSchema`,
 * and returns the typed catalog. Throws on any failure (HTTP error, JSON
 * parse error, schema validation error).
 *
 * The `fetch` and `timeoutMs` are injectable for tests. The default uses
 * the global `fetch` (Web standard; available on Vercel Edge) and a
 * 5-second timeout.
 */

export interface FetchCatalogOptions {
	fetch?: typeof fetch
	timeoutMs?: number
}

export async function fetchCatalog(url: string, opts: FetchCatalogOptions = {}): Promise<Catalog> {
	const f = opts.fetch ?? globalThis.fetch
	const timeoutMs = opts.timeoutMs ?? 5000

	const controller = new AbortController()
	const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const res = await f(url, { signal: controller.signal })
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`)
		}
		const json: unknown = await res.json()
		const parsed = CatalogSchema.safeParse(json)
		if (!parsed.success) {
			throw new Error(
				`catalog validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
			)
		}
		return parsed.data
	} finally {
		clearTimeout(timeoutHandle)
	}
}
