import type { RegistryCatalogResponseSchema } from "@repo/protocol"
import { useSyncExternalStore } from "react"
import type { z } from "zod"

type CatalogPacks = z.infer<typeof RegistryCatalogResponseSchema>["packs"]

/**
 * Module-level singleton cache for the catalog fetch.
 *
 * The catalog is fetched once per page load and reused across every
 * component that mounts it (the landing page, the catalog section,
 * future search surfaces). The cache survives navigation between
 * `/` and `/packs/:scope/:name` so the user does not see a loading
 * state flash when they pop back to the catalog (VAL-WEB-009).
 *
 * The cache is intentionally module-scoped (not context-scoped) so
 * multiple mounts of the catalog in different positions of the tree
 * share state without prop-drilling.
 *
 * Manual invalidation: `setCachedCatalog(null)` clears the cache and
 * triggers a re-render for subscribers. There is no automatic refresh
 * today — the assertion suite does not require one and adding a
 * stale-while-revalidate layer is a future-feature concern.
 */

let cached: CatalogPacks | null = null
const listeners = new Set<() => void>()

function emit(): void {
	for (const listener of listeners) listener()
}

export function getCachedCatalog(): CatalogPacks | null {
	return cached
}

export function setCachedCatalog(packs: CatalogPacks | null): void {
	if (cached === packs) return
	cached = packs
	emit()
}

export function subscribeCatalogCache(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/**
 * React hook returning the cached catalog or `null` if it has not
 * been loaded yet. Subscribes to cache mutations.
 */
export function useCachedCatalog(): CatalogPacks | null {
	return useSyncExternalStore(subscribeCatalogCache, getCachedCatalog, () => null)
}
