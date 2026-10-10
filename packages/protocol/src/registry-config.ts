import { z } from "zod"

/**
 * Per-registry credential contract (architecture §8 decision 4 + decision 33).
 *
 * The CLI stores one credential per registry base URL in the user
 * config file `${BAKA_HOME:-$HOME/.baka}/config.json`, under a top-level
 * `registries` map keyed by the normalized registry URL:
 *
 *   {
 *     "worker": { ... },
 *     "validator": { ... },
 *     "registries": {
 *       "http://localhost:4300": { "apiKey": "<key>" },
 *       "http://other:4310":     { "apiKey": "<key>" }
 *     }
 *   }
 *
 * `apiKey` is the only field in v1: GitHub OAuth issues session cookies,
 * but the CLI surfaces a long-lived API key (created through the
 * registry's API-key endpoint) and stores it here. New credential
 * mechanisms (refresh tokens, OAuth bearer) extend this schema; do not
 * introduce a parallel key shape.
 */
export const RegistryCredentialSchema = z.object({
	apiKey: z.string().min(1),
})

export type RegistryCredential = z.infer<typeof RegistryCredentialSchema>

/**
 * Registry config map shape — the `registries` section of the user
 * config file. Keys are normalized registry base URLs; values are
 * the credentials issued by that registry.
 */
export const RegistryConfigMapSchema = z.record(z.string(), RegistryCredentialSchema)

export type RegistryConfigMap = z.infer<typeof RegistryConfigMapSchema>

// ---------------------------------------------------------------------------
// Wire schemas for the baka registry (architecture §4.5 / §4.6).
//
// These narrow the JSON the registry serves to the fields the MCP
// registry-discovery tools (and any other protocol-level consumer)
// actually rely on. The MCP tools are READ-ONLY (architecture §8
// decision 9: "MCP has no install tool") so they never need the
// publish-side fields — install is the CLI's job. The schemas below
// are what the MCP tools `baka_registry_search`,
// `baka_registry_get_pack`, `baka_registry_get_preview` validate
// against; every response shape they emit is guaranteed by these
// (an MCP consumer can re-parse the served JSON to verify).
//
// Tiers are the four server-attached values (decision 9 / 26 / 31);
// an unknown tier is a registry bug, not a publish surface.
// ---------------------------------------------------------------------------

export const REGISTRY_TIERS = ["official", "verified", "community-screened", "community-unverified"] as const
export type RegistryTier = (typeof REGISTRY_TIERS)[number]

export const REGISTRY_VISIBILITIES = ["public", "org"] as const
export type RegistryVisibility = (typeof REGISTRY_VISIBILITIES)[number]

export const REGISTRY_VERSION_STATUSES = ["pending", "ingesting", "ready", "failed"] as const
export type RegistryVersionStatus = (typeof REGISTRY_VERSION_STATUSES)[number]

export const REGISTRY_PREVIEW_STATES = ["rendered", "needs-llm"] as const
export type RegistryPreviewState = (typeof REGISTRY_PREVIEW_STATES)[number]

/**
 * One row of `GET /v1/packs` (the catalog list). Mirrors the
 * columns the registry serves today (`scope`, `name`, `tier`,
 * `visibility`, `description`, `latestVersion`, `latestStatus`).
 * The list endpoint returns `{ packs: RegistryCatalogEntry[] }`;
 * the per-entry schema below parses one item of that array.
 */
export const RegistryCatalogEntrySchema = z.object({
	scope: z.string().min(1),
	name: z.string().min(1),
	tier: z.enum(REGISTRY_TIERS),
	visibility: z.enum(REGISTRY_VISIBILITIES),
	description: z.string(),
	latestVersion: z.string().nullable(),
	latestStatus: z.string().nullable(),
})
export type RegistryCatalogEntry = z.infer<typeof RegistryCatalogEntrySchema>

export const RegistryCatalogResponseSchema = z.object({
	packs: z.array(RegistryCatalogEntrySchema),
})

/**
 * Pack detail record from `GET /v1/packs/:scope/:name`. Adds
 * a per-version summary list (newest-first by createdAt desc) and
 * a `latestVersion` pinned to the highest-precedence `ready` tag
 * (semver order per architecture §8 decision 11).
 */
export const RegistryVersionSummarySchema = z.object({
	version: z.string().min(1),
	status: z.string().min(1),
	createdAt: z.string(),
})
export type RegistryVersionSummary = z.infer<typeof RegistryVersionSummarySchema>

export const RegistryPackDetailSchema = z.object({
	scope: z.string().min(1),
	name: z.string().min(1),
	tier: z.enum(REGISTRY_TIERS),
	visibility: z.enum(REGISTRY_VISIBILITIES),
	description: z.string(),
	latestVersion: z.string().nullable(),
	versions: z.array(RegistryVersionSummarySchema),
})
export type RegistryPackDetail = z.infer<typeof RegistryPackDetailSchema>

/**
 * Version detail record from `GET /v1/packs/:scope/:name/:version`.
 * `manifest` is the parsed baka `PackManifest` (the registry
 * re-runs `PackManifestSchema.parse` so schema-defaulted empty
 * arrays like `filePatterns` are guaranteed present). `screening`
 * is the screening record payload or `null` when the version
 * was never screened (built-in packs, decision 31).
 *
 * The full JSON carries `artifacts` (kind/path/size/sha256) too;
 * we mirror that here so the wire surface stays field-for-field
 * equal between the registry and the MCP response (VAL-CROSS-020).
 */
export const RegistryArtifactSchema = z.object({
	kind: z.string().min(1),
	path: z.string().min(1),
	size: z.number().int().nonnegative(),
	sha256: z.string().min(1),
	createdAt: z.string(),
})
export type RegistryArtifact = z.infer<typeof RegistryArtifactSchema>

export const RegistryScreeningSchema = z
	.object({
		verdict: z.string().min(1),
		staticScan: z.unknown().optional(),
		dryRun: z.unknown().optional(),
		outputValidation: z.unknown().optional(),
		createdAt: z.string().nullable().optional(),
	})
	.optional()
	.nullable()

export const RegistryVersionDetailSchema = z.object({
	scope: z.string().min(1),
	name: z.string().min(1),
	tier: z.enum(REGISTRY_TIERS),
	version: z.string().min(1),
	status: z.enum(REGISTRY_VERSION_STATUSES),
	commitSha: z.string(),
	contentHash: z.string(),
	error: z.string().nullable(),
	manifest: z.record(z.string(), z.unknown()),
	screening: RegistryScreeningSchema,
	artifacts: z.array(RegistryArtifactSchema),
	createdAt: z.string(),
})
export type RegistryVersionDetail = z.infer<typeof RegistryVersionDetailSchema>

/**
 * Per-recipe preview record from
 * `GET /v1/packs/:scope/:name/:version/previews` (architecture
 * §8 decision 31, VAL-SCAN-004 / 005 / 019).
 *
 * `state = "rendered"` carries a `files[]` list (path / size /
 * sha256) of every file the recipe wrote during dry-run. `state
 * = "needs-llm"` has no files — the recipe never ran because it
 * declares `requiresReasoning: true`.
 */
export const RegistryPreviewEntrySchema = z.object({
	recipeId: z.string().min(1),
	state: z.enum(REGISTRY_PREVIEW_STATES),
	files: z
		.array(
			z.object({
				path: z.string().min(1),
				size: z.number().int().nonnegative(),
				sha256: z.string().min(1),
			}),
		)
		.optional(),
})
export type RegistryPreviewEntry = z.infer<typeof RegistryPreviewEntrySchema>

export const RegistryPreviewListResponseSchema = z.object({
	previews: z.array(RegistryPreviewEntrySchema),
})
export type RegistryPreviewListResponse = z.infer<typeof RegistryPreviewListResponseSchema>

/**
 * Per-recipe detail record from
 * `GET /v1/packs/:scope/:name/:version/previews/:recipeId`.
 * `files[].content` carries the FILE BYTES for the rendered
 * state; for `needs-llm`, files is either absent (canonical
 * shape) or carries an optional sentinel render. `reason` is
 * the literal registry string naming why the recipe was not
 * executed.
 */
export const RegistryRecipePreviewSchema = z.object({
	recipeId: z.string().min(1),
	state: z.enum(REGISTRY_PREVIEW_STATES),
	reason: z.string().optional(),
	files: z
		.array(
			z.object({
				path: z.string().min(1),
				content: z.string(),
				size: z.number().int().nonnegative(),
				sha256: z.string().min(1),
			}),
		)
		.optional(),
})
export type RegistryRecipePreview = z.infer<typeof RegistryRecipePreviewSchema>

// ---------------------------------------------------------------------------
// Registry URL resolution (architecture §8 decisions 4 + 27; shared by the
// CLI and MCP registry surfaces so the two resolve identical chains).
//
// The shared rule: a single explicit `flagValue` REPLACES the entire list
// (one URL pins the consumer to that one registry); a single env value
// becomes a one-element list; the project `.baka/settings.json` `registries`
// list contributes its full ordered list; the documented default kicks
// in when nothing else is configured (`http://localhost:4300`).
//
// The MCP server has no CLI flags, so the MCP wrapper calls this with
// `flagValue: undefined` and passes only the env + project settings —
// the resulting chain is `env > project_settings > default`, identical
// to the CLI's when no `--registry` flag is supplied.
//
// I/O (reading `.baka/settings.json`) lives in the per-app wrapper
// (`apps/cli/src/lib/registry-config.ts` and the new
// `apps/mcp/src/registry-config.ts`); this helper stays pure so it
// stays a single source of truth both wrappers can call.
// ---------------------------------------------------------------------------

export const DEFAULT_REGISTRY_URL = "http://localhost:4300" as const

interface ResolveRegistryListOptions {
	/** Env to read `BAKA_REGISTRY_URL` from (defaults to process.env). */
	env?: NodeJS.ProcessEnv
	/** Pre-loaded project registries (test seam + per-app wrapper). */
	projectRegistries?: string[]
}

/**
 * Returns the ordered list of registry URLs a multi-registry consumer
 * should query. See the file header for the full resolution rule.
 * Empty entries in `projectRegistries` are dropped (a settings file
 * with `["", "http://localhost:4300"]` resolves to the one non-empty
 * entry).
 */
export function resolveRegistryUrlList(flagValue: string | undefined, opts: ResolveRegistryListOptions = {}): string[] {
	const env = opts.env ?? process.env
	const projectRegistries = opts.projectRegistries ?? []
	if (flagValue !== undefined && flagValue.length > 0) {
		return [normalizeRegistryUrl(flagValue)]
	}
	if (typeof env.BAKA_REGISTRY_URL === "string" && env.BAKA_REGISTRY_URL.length > 0) {
		return [normalizeRegistryUrl(env.BAKA_REGISTRY_URL)]
	}
	const out: string[] = []
	for (const entry of projectRegistries) {
		if (typeof entry !== "string" || entry.length === 0) continue
		out.push(normalizeRegistryUrl(entry))
	}
	if (out.length > 0) return out
	return [DEFAULT_REGISTRY_URL]
}

/**
 * Returns the single registry URL a single-registry consumer should
 * use (`flagValue` > `env` > first project registry > default). The
 * CLI's single-registry commands (`baka registry info`, `baka
 * publish`) call this via
 * `apps/cli/src/lib/registry-config.ts`; the MCP wrappers do not
 * currently need a single-reg variant but the helper is exported
 * so a future MCP surface (e.g. a single-registry preview tool)
 * can adopt it without copy-pasting the chain.
 */
export function resolveSingleRegistryUrl(flagValue: string | undefined, opts: ResolveRegistryListOptions = {}): string {
	const [first] = resolveRegistryUrlList(flagValue, opts)
	return first ?? DEFAULT_REGISTRY_URL
}

/**
 * Normalizes a registry base URL for use as a stable storage key
 * (architecture §8 decision 4). Two URLs that resolve to the same
 * origin (scheme + host + port) MUST produce the same key so a user
 * is not silently creating duplicate credentials. Trailing slashes
 * are dropped; the scheme and host are lowercased; the path is
 * preserved verbatim.
 *
 * Examples:
 *   - `http://localhost:4300`        → `http://localhost:4300`
 *   - `http://localhost:4300/`       → `http://localhost:4300`
 *   - `HTTP://Localhost:4300`        → `http://localhost:4300`
 *   - `http://localhost:4300/base/`  → `http://localhost:4300/base`
 *
 * Throws when the input is not a valid URL — the caller is expected
 * to validate the URL before passing it here (e.g. the CLI's --registry
 * flag is parsed against this contract at the command boundary).
 */
export function normalizeRegistryUrl(url: string): string {
	const trimmed = url.trim()
	if (trimmed.length === 0) throw new Error("registry URL must not be empty")
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		throw new Error(`invalid registry URL: ${url}`)
	}
	// URL already lowercases the host. Lowercase the scheme explicitly
	// for symmetry (URL keeps it lowercased by default; this is a
	// belt-and-braces guard against future URL polyfill quirks).
	const scheme = parsed.protocol.toLowerCase()
	const host = parsed.host.toLowerCase()
	const path = parsed.pathname.replace(/\/+$/, "")
	return `${scheme}//${host}${path}`
}
