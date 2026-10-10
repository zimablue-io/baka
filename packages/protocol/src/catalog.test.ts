// Contract tests for the catalog schemas and the built-in catalog.
// Production BUILT_IN_CATALOG is empty until a pack is productized.

import { describe, expect, it } from "vitest"
import { BUILT_IN_CATALOG } from "./built-in-catalog"
import {
	AggregateRequestSchema,
	ApiPackEntrySchema,
	CatalogSchema,
	PackEntrySchema,
	TIER_VALUES,
	type Tier,
} from "./catalog"

// A minimal but valid baka manifest.
const validManifest = {
	name: "baka-acme-auth",
	version: "1.0.0",
	description: "Acme-flavored Better-Auth setup",
	dependencies: [],
	conflictsWith: [],
	recipes: [
		{
			id: "install",
			description: "Install Better-Auth with Acme defaults",
			params: [],
			requiresReasoning: false,
			filePatterns: ["auth.ts"],
			validators: [],
		},
	],
	packValidators: [],
}

const validOwner = { name: "Acme" }

describe("PackEntrySchema", () => {
	it("accepts a valid pack entry", () => {
		const result = PackEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth@v1.0.0",
		})
		expect(result.success).toBe(true)
	})

	it("rejects an entry without a source", () => {
		const result = PackEntrySchema.safeParse({ ...validManifest })
		expect(result.success).toBe(false)
	})

	it("rejects an entry with empty recipes", () => {
		const result = PackEntrySchema.safeParse({
			...validManifest,
			recipes: [],
			source: "git:github.com/acme/baka-acme-auth",
		})
		expect(result.success).toBe(false)
	})

	it("accepts an entry with valid visual metadata", () => {
		const result = PackEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth",
			icon: "https://acme.com/icon.svg",
			accent: "#F5E6A8",
		})
		expect(result.success).toBe(true)
	})

	it("rejects an entry with an invalid accent color", () => {
		const result = PackEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth",
			accent: "yellow", // not a hex color
		})
		expect(result.success).toBe(false)
	})

	it("accepts short and long hex accent colors", () => {
		for (const accent of ["#F5E6A8", "#FFF", "#F5E6A880"]) {
			const result = PackEntrySchema.safeParse({
				...validManifest,
				source: "git:github.com/acme/baka-acme-auth",
				accent,
			})
			expect(result.success, `accent=${accent}`).toBe(true)
		}
	})
})

describe("CatalogSchema", () => {
	const validCatalog = {
		$schema: "https://baka.foo/schemas/catalog.v1.json",
		name: "acme-catalog",
		version: "1.0.0",
		description: "Acme's baka packs",
		owner: validOwner,
		homepage: "https://github.com/acme/baka-catalog",
		packs: [
			{
				...validManifest,
				source: "git:github.com/acme/baka-acme-auth@v1.0.0",
				tags: ["auth", "next"],
			},
		],
	}

	it("accepts a valid catalog", () => {
		const result = CatalogSchema.safeParse(validCatalog)
		expect(result.success).toBe(true)
	})

	it("rejects a non-kebab-case catalog name", () => {
		const result = CatalogSchema.safeParse({ ...validCatalog, name: "Acme Catalog" })
		expect(result.success).toBe(false)
	})

	it("rejects a catalog with no owner", () => {
		const { owner, ...rest } = validCatalog
		const result = CatalogSchema.safeParse(rest)
		expect(result.success).toBe(false)
		void owner // silence unused
	})

	it("accepts a catalog with an empty packs array (publish a shell first)", () => {
		const result = CatalogSchema.safeParse({ ...validCatalog, packs: [] })
		expect(result.success).toBe(true)
	})

	it("rejects a pack with malformed marketplace fields", () => {
		const result = CatalogSchema.safeParse({
			...validCatalog,
			packs: [
				{
					...validManifest,
					source: "git:github.com/acme/baka-acme-auth",
					homepage: "not-a-url",
				},
			],
		})
		expect(result.success).toBe(false)
	})
})

describe("ApiPackEntrySchema", () => {
	it("attaches a tier to a valid pack entry", () => {
		const result = ApiPackEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth",
			tier: "verified",
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.tier).toBe<Tier>("verified")
		}
	})

	it("rejects an entry without a tier", () => {
		const result = ApiPackEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth",
		})
		expect(result.success).toBe(false)
	})

	it("rejects an entry with an unknown tier", () => {
		const result = ApiPackEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth",
			tier: "official", // not in TIER_VALUES
		})
		expect(result.success).toBe(false)
	})

	it("TIER_VALUES is in priority order", () => {
		expect(TIER_VALUES).toEqual(["built-in", "verified", "community"])
	})
})

describe("AggregateRequestSchema", () => {
	it("accepts a non-empty list of URLs", () => {
		const result = AggregateRequestSchema.safeParse({
			catalogs: ["https://acme.com/catalog.json"],
		})
		expect(result.success).toBe(true)
	})

	it("rejects an empty list", () => {
		const result = AggregateRequestSchema.safeParse({ catalogs: [] })
		expect(result.success).toBe(false)
	})

	it("rejects a list with more than 50 URLs", () => {
		const result = AggregateRequestSchema.safeParse({
			catalogs: Array.from({ length: 51 }, () => "https://example.com/c.json"),
		})
		expect(result.success).toBe(false)
	})

	it("rejects non-URL entries", () => {
		const result = AggregateRequestSchema.safeParse({ catalogs: ["not-a-url"] })
		expect(result.success).toBe(false)
	})
})

describe("BUILT_IN_CATALOG", () => {
	it("does not ship example packs as the product catalog", () => {
		expect(BUILT_IN_CATALOG.packs).toEqual([])
	})
})
