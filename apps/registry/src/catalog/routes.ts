import type { PGlite } from "@electric-sql/pglite"
import type { betterAuth } from "better-auth"
import { Hono } from "hono"
import { resolveIdentity } from "../auth/identity"
import { compareSemver } from "../semver-compare"
import type { StorageAdapter } from "../storage"

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
	/**
	 * Storage adapter for serving the tarball artifact. The download
	 * endpoint (VAL-PUB-007) reads the blob via this adapter; all other
	 * read endpoints serve JSON only. Optional so test fixtures that
	 * only exercise the JSON reads can skip wiring storage; the
	 * download endpoint returns 503 when `storage` is not provided.
	 */
	storage?: StorageAdapter
}

export function createCatalogRoutes(deps: CatalogRoutesDeps): Hono {
	const { auth, pglite, storage } = deps
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

		// Visibility filter (VAL-AUTH-003, VAL-PUB-016, registry-core
		// scrutiny regression): anonymous callers and authenticated
		// non-members see `visibility='public'` modules only; members
		// of an org see that org's `visibility='org'` modules too.
		// Existence is never leaked (an org-visibility module never
		// appears in the list response when the caller cannot prove
		// membership — matching the 404 semantics on the detail
		// endpoint).
		const identity = await resolveIdentity(auth, c.req.raw)
		const memberSlugs = identity ? await loadMemberSlugs(pglite, identity.userId) : ([] as string[])

		const tierClause = effectiveTier ? "AND m.tier = $1" : ""
		const tierParamIndex = effectiveTier ? 1 : 0
		const memberParamIndex = tierParamIndex + 1
		const visibilityClause =
			memberSlugs.length > 0
				? `AND (m.visibility = 'public' OR m.scope = ANY($${memberParamIndex}::text[]))`
				: `AND m.visibility = 'public'`

		// The catalog list returns one row per visible module with
		// the highest-precedence `ready` version (semver order per
		// decision 11, NOT insertion order). We fetch the module
		// metadata + every ready version in one query, then pick the
		// max semver in JS. The published version is preferred over
		// pending / failed versions — a freshly failed publish must
		// never become the latest installable pointer.
		const sql = `
			SELECT m.id            AS module_id,
			       m.scope         AS scope,
			       m.name          AS name,
			       m.tier          AS tier,
			       m.visibility    AS visibility,
			       m.description   AS description,
			       v.version       AS version,
			       v.status        AS status
			  FROM modules m
			  LEFT JOIN module_versions v ON v.module_id = m.id AND v.status = 'ready'
			 WHERE m.removed_at IS NULL
			   ${tierClause}
			   ${visibilityClause}
			 ORDER BY m.scope, m.name
		`

		const params: unknown[] = []
		if (effectiveTier) params.push(effectiveTier)
		if (memberSlugs.length > 0) params.push(memberSlugs)

		const rows = await pglite.query<ModuleVersionRow>(sql, params)

		// Group by module; pick the highest-precedence `ready` version
		// via `compareSemver`. A module with zero `ready` versions
		// (still being ingested, all versions failed) gets a null
		// latestVersion — the catalog then surfaces the module but
		// without a installable version pointer (the detail endpoint
		// serves the full version history, including failures).
		const byModule = new Map<
			string,
			{
				scope: string
				name: string
				tier: string
				visibility: string
				description: string
				latestVersion: string | null
				latestStatus: string | null
			}
		>()
		for (const row of rows.rows) {
			const key = `${row.scope}/${row.name}`
			let entry = byModule.get(key)
			if (entry === undefined) {
				entry = {
					scope: row.scope,
					name: row.name,
					tier: row.tier,
					visibility: row.visibility,
					description: row.description,
					latestVersion: row.version,
					latestStatus: row.status,
				}
				byModule.set(key, entry)
				continue
			}
			if (row.version === null) continue
			if (entry.latestVersion === null || compareSemver(row.version, entry.latestVersion) > 0) {
				entry.latestVersion = row.version
				entry.latestStatus = row.status
			}
		}

		const modules = Array.from(byModule.values()).sort((a, b) => {
			if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1
			return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
		})

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
			// Org-visibility requires the caller to prove org membership
			// (VAL-AUTH-003: uniform filtering across the read surface).
			// An outsider — authenticated but not a member — sees the
			// same 404 as a missing module. Membership is checked via
			// the Better-Auth `member` table; any role counts (owner /
			// admin / member) for visibility.
			const memberCheck = await checkOrgMembership(pglite, auth, c.req.raw, mod.scope)
			if (!memberCheck.ok) {
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

		const moduleRow = await pglite.query<{ id: string; scope: string; visibility: string }>(
			`SELECT id, scope, visibility FROM modules WHERE scope = $1 AND name = $2 AND removed_at IS NULL`,
			[scope, name],
		)
		const mod = moduleRow.rows[0]
		if (!mod) {
			return c.json({ error: `module '${scope}/${name}' not found` }, 404, NO_STORE_HEADERS)
		}
		if (mod.visibility === "org") {
			const memberCheck = await checkOrgMembership(pglite, auth, c.req.raw, mod.scope)
			if (!memberCheck.ok) {
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
			const memberCheck = await checkOrgMembership(pglite, auth, c.req.raw, detail.scope)
			if (!memberCheck.ok) {
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
				manifest: stripPrivatePublishKeys(detail.manifest),
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

	// GET /v1/download/:scope/:name/:version — tarball download
	// (VAL-PUB-007 / VAL-PUB-017 / VAL-AUTH-003).
	//
	// The endpoint serves the stored tarball artifact for a ready
	// version. Visibility rules match the detail endpoint exactly:
	//   - public module + any caller → 200 with the tarball body
	//   - public module + missing version → 404 (JSON envelope)
	//   - org-visibility module + non-member → 404 (existence not
	//     leaked — same envelope as a missing module)
	//   - org-visibility module + member → 200 with the tarball body
	//   - any module + version still pending/ingesting → 404 (the
	//     tarball is not yet on disk; we do not surface "still
	//     ingesting" as a 409 because the contract treats
	//     not-yet-stored and not-found the same way)
	//   - any module + version failed → 404 (the failed row exists,
	//     but no artifact was written)
	//
	// The body's sha256 MUST equal the `content_hash` recorded on
	// the version row (VAL-PUB-009). The storage adapter writes the
	// blob with the content hash as the filename, so we look up the
	// tarball artifact row directly and serve its bytes.
	app.get("/v1/download/:scope/:name/:version", async (c) => {
		const scope = c.req.param("scope")
		const name = c.req.param("name")
		const version = c.req.param("version")

		if (storage === undefined) {
			// Tests that don't exercise download can omit the
			// storage adapter; the endpoint returns 503 instead
			// of crashing so the server stays responsive.
			return c.json({ error: `download endpoint unavailable: storage adapter not configured` }, 503, NO_STORE_HEADERS)
		}

		// Single JOIN: module visibility + version row + tarball
		// artifact. The visibility check below is uniform across all
		// three branches (public, org-visibility + member, not
		// found / not yet ready) so a non-member cannot probe for
		// org-visibility modules via timing differences.
		const row = await pglite.query<{
			visibility: string
			artifact_path: string | null
			artifact_sha256: string | null
			content_hash: string
			version_status: string
		}>(
			`SELECT m.visibility      AS visibility,
			        a.path             AS artifact_path,
			        a.sha256           AS artifact_sha256,
			        v.content_hash     AS content_hash,
			        v.status           AS version_status
			   FROM modules m
			   JOIN module_versions v ON v.module_id = m.id
			   LEFT JOIN artifacts a
			          ON a.version_id = v.id
			         AND a.kind = 'tarball'
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
			// Org-visibility requires the caller to prove org membership
			// (VAL-AUTH-003: uniform filtering across the read surface).
			// An outsider — authenticated but not a member — sees the
			// same 404 as a missing module. Existence is not leaked.
			const memberCheck = await checkOrgMembership(pglite, auth, c.req.raw, scope)
			if (!memberCheck.ok) {
				return c.json({ error: `version '${scope}/${name}@${version}' not found` }, 404, NO_STORE_HEADERS)
			}
		}
		// The tarball is only present after the worker promotes the
		// version to `ready`. A pending / ingesting / failed row has
		// no artifact; we 404 rather than 409 because the catalog
		// contract treats "not yet installable" and "not found" the
		// same way (no version-state leak to non-members).
		if (detail.artifact_path === null || detail.artifact_sha256 === null || detail.version_status !== "ready") {
			return c.json({ error: `version '${scope}/${name}@${version}' not found` }, 404, NO_STORE_HEADERS)
		}

		const bytes = await storage.get(detail.artifact_sha256)
		if (bytes === null) {
			// The DB says the blob exists but the storage adapter
			// cannot find it — surface the inconsistency honestly
			// (an operator action is needed: re-publish or
			// re-upload). A 500 is appropriate here because the
			// catalog row is in a state the server cannot serve.
			return c.json(
				{
					error:
						`tarball artifact for version '${scope}/${name}@${version}' is missing from storage ` +
						`(sha256='${detail.artifact_sha256}'); the operator must re-publish`,
				},
				500,
				NO_STORE_HEADERS,
			)
		}

		const filename = `${scope}-${name}-${version}.tar`
		return new Response(bytes, {
			status: 200,
			headers: {
				"content-type": "application/x-tar",
				"content-length": String(bytes.byteLength),
				"content-disposition": `attachment; filename="${filename}"`,
				"x-content-sha256": detail.artifact_sha256,
				"cache-control": "no-store",
			},
		})
	})

	return app
}

// ---------------------------------------------------------------------------
// Internal types (PGlite row shapes — date columns come back as Date objects
// after the timestamp cast; postgres `jsonb` columns come back as already-
// parsed values).
// ---------------------------------------------------------------------------

interface ModuleSummaryRow {
	module_id: string
	scope: string
	name: string
	tier: string
	visibility: string
	description: string
	version: string | null
	status: string | null
}

/**
 * Alias kept for compatibility with the older LATERAL-JOIN shape.
 * The list endpoint now joins `module_versions` directly (one row
 * per ready version per module) and picks the max semver in JS.
 */
type ModuleVersionRow = ModuleSummaryRow

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

/**
 * Strips the publish endpoint's private `_publish` payload from the
 * served manifest. The publish endpoint persists `repo`, `modulePath`,
 * and `publishedAt` under a `_publish` key so the ingest worker can
 * re-clone without a dedicated column. The catalog surfaces MUST
 * NOT expose those fields (they are operator metadata, not module
 * contract); a fresh publish writes them once, and every read
 * surfaces the manifest without them.
 */
function stripPrivatePublishKeys(manifest: unknown): Record<string, unknown> | unknown {
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
		return manifest
	}
	const copy = { ...(manifest as Record<string, unknown>) }
	delete copy._publish
	return copy
}

interface ArtifactRow {
	id: string
	kind: string
	path: string
	size: number
	sha256: string
	created_at: Date
}

/**
 * Returns the set of org slugs the given user is a member of (any
 * role — owner / admin / member all qualify for visibility). Empty
 * array when the user is not authenticated or has no memberships.
 *
 * The query joins Better-Auth's `member` table to the `organization`
 * table to map user ids to org slugs in one round trip. The slug list
 * is fed directly into a PostgreSQL `ANY($1::text[])` so the SQL stays
 * parameterized (no string interpolation, no SQL injection surface).
 *
 * Identity resolution lives one level up (`resolveIdentity`); this
 * helper trusts the user id passed to it.
 */
async function loadMemberSlugs(pglite: PGlite, userId: string): Promise<string[]> {
	const rows = await pglite.query<{ slug: string }>(
		`SELECT o.slug
		   FROM "member" m
		   JOIN "organization" o ON o.id = m."organizationId"
		  WHERE m."userId" = $1`,
		[userId],
	)
	return rows.rows.map((r) => r.slug)
}

/**
 * Resolves the request's identity and confirms the caller is a member
 * of the org identified by `scope`. Returns `{ ok: true }` when the
 * caller is a member of any role (owner / admin / member) and
 * `{ ok: false }` otherwise (anonymous, authenticated but not a
 * member, or the org does not exist).
 *
 * Used by every read endpoint that gates an org-visibility module
 * (VAL-AUTH-003: uniform visibility filtering across the read surface).
 * The detail / version-detail / download endpoints all defer to this
 * helper so the membership check is identical at every callsite —
 * a future fix lands in one place, not three.
 */
async function checkOrgMembership(
	pglite: PGlite,
	auth: ReturnType<typeof betterAuth>,
	request: Request,
	scope: string,
): Promise<{ ok: true; userId: string } | { ok: false }> {
	const identity = await resolveIdentity(auth, request)
	if (!identity) return { ok: false }
	const memberSlugs = await loadMemberSlugs(pglite, identity.userId)
	if (!memberSlugs.includes(scope)) return { ok: false }
	return { ok: true, userId: identity.userId }
}
