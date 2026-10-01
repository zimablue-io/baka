import { createHash } from "node:crypto"
import type { PGlite } from "@electric-sql/pglite"
import { BUILT_IN_CATALOG, type ModuleEntry } from "@repo/protocol"

/**
 * Built-in catalog seeder (architecture §2 / §4.5, decision 17).
 *
 * The registry seeds its catalog from `BUILT_IN_CATALOG` in
 * `@repo/protocol`. That catalog is empty until a module is
 * productized. Tests call `seedCatalogModules` with a tiny fixture.
 * On boot, after the schema-version gate and Better-Auth bootstrap,
 * this helper inserts one `modules` row per entry and a matching
 * `module_versions` row at `status: "ready"`. Seeded modules are
 * public and pinned to the `official` tier (architecture §4.3 —
 * `tier` is server-attached, never self-declared).
 *
 * The seeder is idempotent: a second invocation against an already-
 * seeded data dir is a no-op. `commit_sha` is a deterministic 40-zero
 * placeholder (built-in modules have no real git ref); `content_hash`
 * is the SHA-256 of the canonical manifest JSON so re-seeding produces
 * the same hash and the dedup invariant holds.
 *
 * Decision 31: built-in modules bypass the screening pipeline (they
 * ship in-tree and are vetted by the engine maintainers), so the
 * version-detail JSON returns `screening: null` — the same shape an
 * unscreened community publish produces.
 *
 * `officialOrg` is the slug the registry booted with (architecture
 * §8 decision 26); bare-name resolution and the publish route map
 * to this scope. The seeder pins the built-in modules to the same
 * scope so the catalog list and the publish route agree on where
 * bare names live.
 */

const BUILT_IN_TIER = "official"
const BUILT_IN_VISIBILITY = "public"
const BUILT_IN_STATUS = "ready"
const BUILT_IN_COMMIT_SHA = "0".repeat(40)

/**
 * Stable JSON serialization (sorted keys at every level). The DB stores
 * `manifest` as jsonb; the `content_hash` is the SHA-256 of this canonical
 * form so re-seeding always produces the same hash and the unique key
 * invariant holds across boots.
 */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex")
}

interface SeededCounts {
	modulesInserted: number
	versionsInserted: number
	modulesSkipped: number
}

/**
 * Seeds `BUILT_IN_CATALOG` into the registry database. Returns the
 * insertion / skip counts so the operator log can confirm what
 * happened on this boot.
 *
 * Idempotent: rows that already exist under `(scope, name)` are left
 * alone. The same applies to versions (a row with the same `(module_id,
 * version)` is left alone, so re-publishing a built-in module
 * intentionally is a no-op).
 */
export async function seedCatalogModules(
	pglite: PGlite,
	officialOrg: string,
	modules: readonly ModuleEntry[],
): Promise<SeededCounts> {
	const counts: SeededCounts = { modulesInserted: 0, versionsInserted: 0, modulesSkipped: 0 }

	for (const entry of modules) {
		const existingModule = await pglite.query<{ id: string }>(`SELECT id FROM modules WHERE scope = $1 AND name = $2`, [
			officialOrg,
			entry.name,
		])
		let moduleId: string
		if (existingModule.rows[0]?.id) {
			moduleId = existingModule.rows[0].id
			counts.modulesSkipped += 1
		} else {
			const inserted = await pglite.query<{ id: string }>(
				`INSERT INTO modules (scope, name, visibility, tier, description)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING id`,
				[officialOrg, entry.name, BUILT_IN_VISIBILITY, BUILT_IN_TIER, entry.description],
			)
			const id = inserted.rows[0]?.id
			if (!id) throw new Error(`seedCatalogModules: failed to insert module ${entry.name}`)
			moduleId = id
			counts.modulesInserted += 1
		}

		const existingVersion = await pglite.query<{ id: string }>(
			`SELECT id FROM module_versions WHERE module_id = $1 AND version = $2`,
			[moduleId, entry.version],
		)
		if (existingVersion.rows[0]?.id) continue

		const manifestJson = canonicalJson(entry)
		const contentHash = sha256Hex(manifestJson)
		await pglite.query(
			`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
			[moduleId, entry.version, BUILT_IN_COMMIT_SHA, contentHash, manifestJson, BUILT_IN_STATUS],
		)
		counts.versionsInserted += 1
	}

	return counts
}

/**
 * Seeds `BUILT_IN_CATALOG` (empty until a module is productized).
 */
export async function seedBuiltInCatalog(pglite: PGlite, officialOrg: string): Promise<SeededCounts> {
	return seedCatalogModules(pglite, officialOrg, BUILT_IN_CATALOG.modules)
}
