import type { PGlite } from "@electric-sql/pglite"
import type { betterAuth } from "better-auth"
import { Hono } from "hono"
import { resolveIdentity } from "../auth/identity"

/**
 * Catalog read paths (architecture §4.5, decision 25 / 31).
 *
 * Endpoints (all read-only; all carry `Cache-Control: no-store`):
 *   - GET  /v1/modules                     — full catalog list, optional `?tier=`
 *   - GET  /v1/modules/:scope/:name        — module detail with versions summary
 *   - GET  /v1/modules/:scope/:name/versions — versions list
 *   - GET  /v1/modules/:scope/:name/:version — version detail + manifest + screening
 *
 * Tiers come from the database `tier` column (server-attached; never
 * self-declared by publishers). The closed set is the four documented
 * values; an unknown tier query returns 400 — never silently returns
 * every module (VAL-PUB-029).
 *
 * Decision 25 (Cache-Control: no-store): the v1 contract is "updates
 * visible immediately" — no TTL hedging. Every response below sets the
 * header before returning.
 *
 * Decision 31 (screening embedded in version detail): the version
 * detail response carries a `screening` field whose value is the
 * `screening_results` row's payload (`{ verdict, staticScan, dryRun,
 * createdAt }`) or `null` when the version was never screened. There
 * is no separate screening endpoint.
 *
 * Visibility (VAL-AUTH-003): the catalog list endpoint and the module
 * detail endpoint filter out org-visibility modules for callers who
 * cannot prove org membership. The seeded built-in catalog is all
 * `public`, so the anonymous reads below return the full set. An
 * org-visibility module returns the same 404 as a missing module so
 * existence is not leaked.
 */

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const

const CATALOG_TIERS = ["official", "verified", "community-screened", "community-unverified"] as const
type CatalogTier = (typeof CATALOG_TIERS)[number]

function isCatalogTier(value: string): value is CatalogTier {
	return (CATALOG_TIERS as readonly string[]).includes(value)
}

interface CatalogRoutesDeps {
	auth: ReturnType<typeof betterAuth>
	pglite: PGlite
}

export function createCatalogRoutes(deps: CatalogRoutesDeps): Hono {
	const { auth, pglite } = deps
	const app = new Hono()

	// GET /v1/modules?tier=...
	app.get("/v1/modules", async (c) => {
		const tierParam = c.req.query("tier")
		// Decision: an empty string (e.g. `?tier=`) is treated like an
		// unknown tier — 400 with an honest error. A missing query param
		// is fine (returns every visible module).
		if (tierParam !== undefined) {
			if (tierParam.length === 0 || !isCatalogTier(tierParam)) {
				return c.json(
					{
						error: `unknown tier '${tierParam}'; expected one of ${CATALOG_TIERS.join(", ")}`,
					},
					400,
					NO_STORE_HEADERS,
				)
			}
		}
		const effectiveTier = tierParam !== undefined && tierParam.length > 0 ? tierParam : null

		const rows = effectiveTier
			? await pglite.query<ModuleSummaryRow>(
					`SELECT m.scope, m.name, m.tier, m.visibility, m.description,
					        v.version   AS latest_version,
					        v.status    AS latest_status
					   FROM modules m
					   LEFT JOIN LATERAL (
					     SELECT version, status
					       FROM module_versions
					      WHERE module_id = m.id
					      ORDER BY created_at DESC
					      LIMIT 1
					   ) v ON TRUE
					  WHERE m.removed_at IS NULL
					    AND m.tier = $1
					  ORDER BY m.scope, m.name`,
					[effectiveTier],
				)
			: await pglite.query<ModuleSummaryRow>(
					`SELECT m.scope, m.name, m.tier, m.visibility, m.description,
					        v.version   AS latest_version,
					        v.status    AS latest_status
					   FROM modules m
					   LEFT JOIN LATERAL (
					     SELECT version, status
					       FROM module_versions
					      WHERE module_id = m.id
					      ORDER BY created_at DESC
					      LIMIT 1
					   ) v ON TRUE
					  WHERE m.removed_at IS NULL
					  ORDER BY m.scope, m.name`,
				)

		const modules = rows.rows.map((row) => ({
			scope: row.scope,
			name: row.name,
			tier: row.tier,
			visibility: row.visibility,
			description: row.description,
			latestVersion: row.latest_version,
			latestStatus: row.latest_status,
		}))

		return c.json({ modules }, 200, NO_STORE_HEADERS)
	})

	// GET /v1/modules/:scope/:name
	app.get("/v1/modules/:scope/:name", async (c) => {
		const scope = c.req.param("scope")
		const name = c.req.param("name")

		const moduleRow = await pglite.query<ModuleRow>(
			`SELECT id, scope, name, tier, visibility, description
			   FROM modules
			  WHERE scope = $1 AND name = $2 AND removed_at IS NULL`,
			[scope, name],
		)
		const mod = moduleRow.rows[0]
		if (!mod) {
			// Existence is not leaked for org-private modules (VAL-AUTH-003).
			return c.json({ error: `module '${scope}/${name}' not found` }, 404, NO_STORE_HEADERS)
		}
		if (mod.visibility === "org") {
			// Org-visibility requires a resolved identity; an outsider
			// sees the same 404 as a missing module.
			const identity = await resolveIdentity(auth, c.req.raw)
			if (!identity) {
				return c.json({ error: `module '${scope}/${name}' not found` }, 404, NO_STORE_HEADERS)
			}
		}

		const versions = await pglite.query<VersionSummaryRow>(
			`SELECT version, status, created_at
			   FROM module_versions
			  WHERE module_id = $1
			  ORDER BY created_at DESC, version DESC`,
			[mod.id],
		)

		return c.json(
			{
				scope: mod.scope,
				name: mod.name,
				tier: mod.tier,
				visibility: mod.visibility,
				description: mod.description,
				versions: versions.rows.map((v) => ({
					version: v.version,
					status: v.status,
					createdAt: v.created_at.toISOString(),
				})),
			},
			200,
			NO_STORE_HEADERS,
		)
	})

	// GET /v1/modules/:scope/:name/versions
	app.get("/v1/modules/:scope/:name/versions", async (c) => {
		const scope = c.req.param("scope")
		const name = c.req.param("name")

		const moduleRow = await pglite.query<{ id: string; visibility: string }>(
			`SELECT id, visibility FROM modules WHERE scope = $1 AND name = $2 AND removed_at IS NULL`,
			[scope, name],
		)
		const mod = moduleRow.rows[0]
		if (!mod) {
			return c.json({ error: `module '${scope}/${name}' not found` }, 404, NO_STORE_HEADERS)
		}
		if (mod.visibility === "org") {
			const identity = await resolveIdentity(auth, c.req.raw)
			if (!identity) {
				return c.json({ error: `module '${scope}/${name}' not found` }, 404, NO_STORE_HEADERS)
			}
		}

		const versions = await pglite.query<VersionRow>(
			`SELECT version, commit_sha, content_hash, status, error, created_at
			   FROM module_versions
			  WHERE module_id = $1
			  ORDER BY created_at DESC, version DESC`,
			[mod.id],
		)

		return c.json(
			{
				scope,
				name,
				versions: versions.rows.map((v) => ({
					version: v.version,
					status: v.status,
					commitSha: v.commit_sha,
					contentHash: v.content_hash,
					error: v.error,
					createdAt: v.created_at.toISOString(),
				})),
			},
			200,
			NO_STORE_HEADERS,
		)
	})

	// GET /v1/modules/:scope/:name/:version
	app.get("/v1/modules/:scope/:name/:version", async (c) => {
		const scope = c.req.param("scope")
		const name = c.req.param("name")
		const version = c.req.param("version")

		const row = await pglite.query<VersionDetailRow>(
			`SELECT m.id             AS module_id,
			        m.scope          AS scope,
			        m.name           AS name,
			        m.visibility     AS visibility,
			        v.id             AS version_id,
			        v.version        AS version,
			        v.commit_sha     AS commit_sha,
			        v.content_hash   AS content_hash,
			        v.status         AS status,
			        v.error          AS error,
			        v.manifest       AS manifest,
			        v.created_at     AS created_at,
			        s.verdict        AS screening_verdict,
			        s.static_scan    AS screening_static_scan,
			        s.dry_run        AS screening_dry_run,
			        s.created_at     AS screening_created_at
			   FROM modules m
			   JOIN module_versions v ON v.module_id = m.id
			   LEFT JOIN screening_results s ON s.version_id = v.id
			  WHERE m.scope = $1
			    AND m.name = $2
			    AND v.version = $3
			    AND m.removed_at IS NULL`,
			[scope, name, version],
		)
		const detail = row.rows[0]
		if (!detail) {
			return c.json({ error: `version '${scope}/${name}@${version}' not found` }, 404, NO_STORE_HEADERS)
		}
		if (detail.visibility === "org") {
			const identity = await resolveIdentity(auth, c.req.raw)
			if (!identity) {
				return c.json({ error: `version '${scope}/${name}@${version}' not found` }, 404, NO_STORE_HEADERS)
			}
		}

		const artifacts = await pglite.query<ArtifactRow>(
			`SELECT id, kind, path, size, sha256, created_at
			   FROM artifacts
			  WHERE version_id = $1
			  ORDER BY kind, path`,
			[detail.version_id],
		)

		const screening =
			detail.screening_verdict === null || detail.screening_verdict === undefined
				? null
				: {
						verdict: detail.screening_verdict,
						staticScan: detail.screening_static_scan,
						dryRun: detail.screening_dry_run,
						createdAt: detail.screening_created_at?.toISOString() ?? null,
					}

		return c.json(
			{
				scope: detail.scope,
				name: detail.name,
				version: detail.version,
				status: detail.status,
				commitSha: detail.commit_sha,
				contentHash: detail.content_hash,
				error: detail.error,
				manifest: detail.manifest,
				screening,
				artifacts: artifacts.rows.map((a) => ({
					kind: a.kind,
					path: a.path,
					size: a.size,
					sha256: a.sha256,
					createdAt: a.created_at.toISOString(),
				})),
				createdAt: detail.created_at.toISOString(),
			},
			200,
			NO_STORE_HEADERS,
		)
	})

	return app
}

// ---------------------------------------------------------------------------
// Internal types (PGlite row shapes — date columns come back as Date objects
// after the timestamp cast; postgres `jsonb` columns come back as already-
// parsed values).
// ---------------------------------------------------------------------------

interface ModuleSummaryRow {
	scope: string
	name: string
	tier: string
	visibility: string
	description: string
	latest_version: string | null
	latest_status: string | null
}

interface ModuleRow {
	id: string
	scope: string
	name: string
	tier: string
	visibility: string
	description: string
}

interface VersionSummaryRow {
	version: string
	status: string
	created_at: Date
}

interface VersionRow {
	version: string
	commit_sha: string
	content_hash: string
	status: string
	error: string | null
	created_at: Date
}

interface VersionDetailRow {
	module_id: string
	scope: string
	name: string
	visibility: string
	version_id: string
	version: string
	commit_sha: string
	content_hash: string
	status: string
	error: string | null
	manifest: unknown
	created_at: Date
	screening_verdict: string | null
	screening_static_scan: unknown
	screening_dry_run: unknown
	screening_created_at: Date | null
}

interface ArtifactRow {
	id: string
	kind: string
	path: string
	size: number
	sha256: string
	created_at: Date
}
