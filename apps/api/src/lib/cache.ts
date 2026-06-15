/**
 * A tiny TTL-bounded in-memory cache.
 *
 * Designed for the marketplace API's read-heavy edge workload: catalogs
 * and aggregated results don't need to be perfect, and a 5-minute stale
 * window is fine for a free marketplace. The cache is per-process; on
 * Vercel Edge each region has its own copy, which is acceptable because
 * upstream catalog publishers also cache at their edge.
 *
 * This is deliberately a single `Map`, not an LRU. The expected working
 * set is small (tens to a few hundred catalog URLs) and entries expire
 * on a fixed timer, so eviction is by expiry rather than by recency.
 */
export class TTLCache<K, V> {
	private readonly map = new Map<K, { value: V; expiresAt: number }>()

	constructor(private readonly ttlMs: number) {}

	get(key: K): V | undefined {
		const entry = this.map.get(key)
		if (!entry) return undefined
		if (Date.now() > entry.expiresAt) {
			this.map.delete(key)
			return undefined
		}
		return entry.value
	}

	set(key: K, value: V): void {
		this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
	}

	delete(key: K): void {
		this.map.delete(key)
	}

	clear(): void {
		this.map.clear()
	}

	size(): number {
		return this.map.size
	}
}
