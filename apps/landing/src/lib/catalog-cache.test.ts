import { afterEach, describe, expect, it } from "vitest"
import { getCachedCatalog, setCachedCatalog, subscribeCatalogCache } from "./catalog-cache"

const SAMPLE_PACKS = [
	{
		scope: "baka",
		name: "widget",
		tier: "official" as const,
		visibility: "public" as const,
		description: "A sample catalog pack.",
		latestVersion: "0.1.0",
		latestStatus: "ready",
	},
]

afterEach(() => {
	setCachedCatalog(null)
})

describe("catalog cache", () => {
	it("starts empty", () => {
		expect(getCachedCatalog()).toBeNull()
	})

	it("stores and returns packs", () => {
		setCachedCatalog(SAMPLE_PACKS)
		expect(getCachedCatalog()).toEqual(SAMPLE_PACKS)
	})

	it("clears the cache when set to null", () => {
		setCachedCatalog(SAMPLE_PACKS)
		setCachedCatalog(null)
		expect(getCachedCatalog()).toBeNull()
	})

	it("does not emit when the same reference is set twice", () => {
		setCachedCatalog(SAMPLE_PACKS)
		let calls = 0
		const unsubscribe = subscribeCatalogCache(() => {
			calls += 1
		})
		setCachedCatalog(SAMPLE_PACKS)
		unsubscribe()
		expect(calls).toBe(0)
	})

	it("emits to subscribers when the catalog changes", () => {
		const events: number[] = []
		const unsubscribe = subscribeCatalogCache(() => {
			events.push(getCachedCatalog()?.length ?? 0)
		})
		setCachedCatalog(SAMPLE_PACKS)
		setCachedCatalog(null)
		setCachedCatalog([])
		unsubscribe()
		expect(events).toEqual([1, 0, 0])
	})
})
