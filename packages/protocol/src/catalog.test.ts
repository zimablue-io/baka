// Contract tests for the catalog schemas and the built-in catalog. The
// catalog schema is the wire contract between catalog publishers, the
// marketplace API (apps/api, later apps/registry), and consumers (the CLI,
// the landing app). The built-in catalog is the single source of truth for
// the first-party modules that ship with the engine; every served copy
// (apps/api /v1/built-in today, the registry seed in milestone 2) derives
// from BUILT_IN_CATALOG.

import { describe, expect, it } from "vitest"
import { BUILT_IN_CATALOG } from "./built-in-catalog"
import {
	AggregateRequestSchema,
	ApiModuleEntrySchema,
	CatalogSchema,
	ModuleEntrySchema,
	TIER_VALUES,
	type Tier,
} from "./catalog"

// A minimal but valid baka manifest (mirrors modules/baka-base's shape).
const validManifest = {
	name: "baka-acme-auth",
	version: "1.0.0",
	description: "Acme-flavored Better-Auth setup",
	dependencies: [],
	conflictsWith: [],
	actions: [
		{
			id: "install",
			description: "Install Better-Auth with Acme defaults",
			params: [],
			requiresReasoning: false,
			filePatterns: ["auth.ts"],
			validators: [],
		},
	],
	moduleValidators: [],
}

const validOwner = { name: "Acme" }

describe("ModuleEntrySchema", () => {
	it("accepts a valid module entry", () => {
		const result = ModuleEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth@v1.0.0",
		})
		expect(result.success).toBe(true)
	})

	it("rejects an entry without a source", () => {
		const result = ModuleEntrySchema.safeParse({ ...validManifest })
		expect(result.success).toBe(false)
	})

	it("rejects an entry with empty actions", () => {
		const result = ModuleEntrySchema.safeParse({
			...validManifest,
			actions: [],
			source: "git:github.com/acme/baka-acme-auth",
		})
		expect(result.success).toBe(false)
	})

	it("accepts an entry with valid visual metadata", () => {
		const result = ModuleEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth",
			icon: "https://acme.com/icon.svg",
			accent: "#F5E6A8",
		})
		expect(result.success).toBe(true)
	})

	it("rejects an entry with an invalid accent color", () => {
		const result = ModuleEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth",
			accent: "yellow", // not a hex color
		})
		expect(result.success).toBe(false)
	})

	it("accepts short and long hex accent colors", () => {
		for (const accent of ["#F5E6A8", "#FFF", "#F5E6A880"]) {
			const result = ModuleEntrySchema.safeParse({
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
		description: "Acme's baka modules",
		owner: validOwner,
		homepage: "https://github.com/acme/baka-catalog",
		modules: [
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

	it("accepts a catalog with an empty modules array (publish a shell first)", () => {
		const result = CatalogSchema.safeParse({ ...validCatalog, modules: [] })
		expect(result.success).toBe(true)
	})

	it("rejects a module with malformed marketplace fields", () => {
		const result = CatalogSchema.safeParse({
			...validCatalog,
			modules: [
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

describe("ApiModuleEntrySchema", () => {
	it("attaches a tier to a valid module entry", () => {
		const result = ApiModuleEntrySchema.safeParse({
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
		const result = ApiModuleEntrySchema.safeParse({
			...validManifest,
			source: "git:github.com/acme/baka-acme-auth",
		})
		expect(result.success).toBe(false)
	})

	it("rejects an entry with an unknown tier", () => {
		const result = ApiModuleEntrySchema.safeParse({
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
	it("contains exactly the three first-party modules", () => {
		const names = BUILT_IN_CATALOG.modules.map((m) => m.name).sort()
		expect(names).toEqual(["baka-base", "sdd", "ts-style"])
	})

	it("every module has a name, version, and at least one action", () => {
		for (const m of BUILT_IN_CATALOG.modules) {
			expect(m.name).toBeTruthy()
			expect(m.version).toBeTruthy()
			expect(m.actions.length).toBeGreaterThan(0)
		}
	})

	it("sdd carries its reasoning actions init-constitution and create-feature", () => {
		const sdd = BUILT_IN_CATALOG.modules.find((m) => m.name === "sdd")
		expect(sdd).toBeDefined()
		const actionIds = (sdd?.actions ?? []).map((a) => a.id).sort()
		expect(actionIds).toEqual(["create-feature", "init-constitution"])
		for (const action of sdd?.actions ?? []) {
			expect(action.requiresReasoning).toBe(true)
		}
	})

	it("sdd is findable by spec-driven terms (constitution, spec)", () => {
		const sdd = BUILT_IN_CATALOG.modules.find((m) => m.name === "sdd")
		const haystack = [sdd?.name, sdd?.description, ...(sdd?.tags ?? []), ...(sdd?.keywords ?? [])]
			.join(" ")
			.toLowerCase()
		expect(haystack).toContain("constitution")
		expect(haystack).toContain("spec")
	})

	it("mirrors the real module manifests", () => {
		const bakaBase = BUILT_IN_CATALOG.modules.find((m) => m.name === "baka-base")
		const scaffold = bakaBase?.actions.find((a) => a.id === "scaffold")
		// modules/baka-base/manifest.ts: scaffold writes package.json,
		// tsconfig.json, src/index.ts, README.md, .gitignore.
		expect(scaffold?.filePatterns).toEqual(["package.json", "tsconfig.json", "src/index.ts", "README.md", ".gitignore"])
		expect(bakaBase?.moduleValidators).toEqual(["hasPackageJson", "tsconfigPresent"])

		const tsStyle = BUILT_IN_CATALOG.modules.find((m) => m.name === "ts-style")
		expect(tsStyle?.dependencies).toEqual(["baka-base"])
		expect(tsStyle?.moduleValidators).toEqual(["noAnyTypes", "noConsoleLog", "explicitReturnTypes"])
		expect(tsStyle?.actions.map((a) => a.id)).toEqual(["install-config", "lint"])

		const sdd = BUILT_IN_CATALOG.modules.find((m) => m.name === "sdd")
		const initConstitution = sdd?.actions.find((a) => a.id === "init-constitution")
		expect(initConstitution?.filePatterns).toEqual(["specs/mission.md", "specs/tech-stack.md", "specs/roadmap.md"])
		expect(initConstitution?.validators).toEqual(["constitutionCoherent"])
		const createFeature = sdd?.actions.find((a) => a.id === "create-feature")
		expect(createFeature?.filePatterns).toEqual(["specs/*/plan.md", "specs/*/requirements.md", "specs/*/validation.md"])
		expect(createFeature?.validators).toEqual(["featureSpecCoherent"])
	})
})
