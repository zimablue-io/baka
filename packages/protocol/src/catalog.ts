import { z } from "zod"
import { PackManifestSchema } from "./schemas"

/**
 * Catalog format (the publisher's contract) and the API response shapes.
 *
 * The catalog is the only file a community maintainer ships. It is a
 * single JSON document that lists the maintainer's baka packs together
 * with marketplace-specific metadata. The marketplace backend fetches the
 * catalog from a URL, validates it against `CatalogSchema`, and serves the
 * validated result to consumers (the landing app, the baka CLI, etc.).
 *
 * Design notes:
 *
 * - `PackEntrySchema` reuses `PackManifestSchema` from `@repo/protocol`
 *   for the baka-specific fields (recipes, validators, filePatterns, ...).
 *   The marketplace schema does not duplicate them; it extends the baka
 *   schema with marketplace-specific and visual fields.
 *
 * - The publisher's `source` field reuses the existing source-string
 *   format (`npm:...`, `git:...`, https URL, local path). The CLI calls
 *   `installSource(source, ...)` directly on it, so the marketplace adds
 *   zero impedance to the install path.
 *
 * - The server-side `tier` field is NOT in `PackEntrySchema`. It is
 *   attached by the API based on the catalog the pack came from.
 *   `ApiPackEntrySchema` is the shape the API emits.
 */

// ---------------------------------------------------------------------------
// Tier (server-attached; publishers cannot self-declare)
// ---------------------------------------------------------------------------

export const TIER_VALUES = ["built-in", "verified", "community"] as const
export type Tier = (typeof TIER_VALUES)[number]

const tierSchema = z.enum(TIER_VALUES)

// ---------------------------------------------------------------------------
// Catalog owner
// ---------------------------------------------------------------------------

export const CatalogOwnerSchema = z.object({
	name: z.string().min(1),
	email: z.string().email().optional(),
})
export type CatalogOwner = z.infer<typeof CatalogOwnerSchema>

// ---------------------------------------------------------------------------
// Pack entry (publisher-facing: baka manifest + marketplace fields)
// ---------------------------------------------------------------------------

export const PackEntrySchema = PackManifestSchema.extend({
	// Marketplace-specific
	source: z.string().min(1),
	author: CatalogOwnerSchema.optional(),
	license: z.string().optional(),
	homepage: z.string().url().optional(),
	tags: z.array(z.string()).default([]),
	category: z.string().optional(),
	keywords: z.array(z.string()).default([]),
	// Visual metadata (optional, minimal)
	icon: z.string().min(1).optional(),
	accent: z
		.string()
		.regex(/^#[0-9A-Fa-f]{3,8}$/, "accent must be a hex color like #F5E6A8")
		.optional(),
})
export type PackEntry = z.infer<typeof PackEntrySchema>

// ---------------------------------------------------------------------------
// Catalog (publisher-facing: the JSON document a community maintainer ships)
// ---------------------------------------------------------------------------

export const CatalogSchema = z.object({
	$schema: z.string().optional(),
	name: z
		.string()
		.min(1)
		.regex(/^[a-z0-9-]+$/, "catalog name must be kebab-case (lowercase, digits, hyphens)"),
	version: z.string().min(1),
	description: z.string().default(""),
	owner: CatalogOwnerSchema,
	homepage: z.string().url().optional(),
	packs: z.array(PackEntrySchema).default([]),
})
export type Catalog = z.infer<typeof CatalogSchema>

// ---------------------------------------------------------------------------
// API response shapes (server attaches `tier`)
// ---------------------------------------------------------------------------

export const ApiPackEntrySchema = PackEntrySchema.extend({
	tier: tierSchema,
})
export type ApiPackEntry = z.infer<typeof ApiPackEntrySchema>

export const ApiCatalogSchema = CatalogSchema.extend({
	packs: z.array(ApiPackEntrySchema),
})
export type ApiCatalog = z.infer<typeof ApiCatalogSchema>

// ---------------------------------------------------------------------------
// Wire types for the other API endpoints
// ---------------------------------------------------------------------------

/** `/v1/aggregate` request body. */
export const AggregateRequestSchema = z.object({
	catalogs: z.array(z.string().url()).min(1).max(50),
})
export type AggregateRequest = z.infer<typeof AggregateRequestSchema>

/** `/v1/aggregate` per-catalog error block. */
export const CatalogErrorSchema = z.object({
	url: z.string(),
	error: z.string(),
})
export type CatalogError = z.infer<typeof CatalogErrorSchema>

/** `/v1/aggregate` response body. */
export const AggregateResponseSchema = z.object({
	packs: z.array(ApiPackEntrySchema),
	catalogErrors: z.array(CatalogErrorSchema),
})
export type AggregateResponse = z.infer<typeof AggregateResponseSchema>

/** `/v1/packs/:name` response body. */
export const PackLookupResponseSchema = z.object({
	pack: ApiPackEntrySchema,
	source: z.object({
		catalog: z.string(),
		tier: tierSchema,
	}),
})
export type PackLookupResponse = z.infer<typeof PackLookupResponseSchema>

/** `/v1/verified` per-catalog entry. */
export const VerifiedCatalogEntrySchema = z.object({
	url: z.string().url(),
	name: z.string().min(1),
	description: z.string().default(""),
	addedAt: z.string(), // ISO date
})
export type VerifiedCatalogEntry = z.infer<typeof VerifiedCatalogEntrySchema>

/** `/v1/verified` response body. */
export const VerifiedResponseSchema = z.object({
	catalogs: z.array(VerifiedCatalogEntrySchema),
})
export type VerifiedResponse = z.infer<typeof VerifiedResponseSchema>
