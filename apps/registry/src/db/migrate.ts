import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { PGlite } from "@electric-sql/pglite"

/**
 * Forward-only SQL migration runner (architecture §8 decision 28).
 *
 * The set of migrations is a fixed array of `{ version, sql }` pairs read
 * from the on-disk migration directory at construction. Each migration is
 * applied at most once; re-running the runner is a no-op once the
 * `app_migrations` row is recorded.
 *
 * The runner is intentionally NOT a general-purpose migration tool. The
 * registry's migration policy is forward-only and the set of migrations
 * is known at build time (we ship them as bundled SQL). Adding a new
 * migration means: write the SQL file, append the entry here, and bump
 * CURRENT_SCHEMA_VERSION in `schema-version.ts` in the same change.
 */

interface Migration {
	version: string
	sql: string
}

// Inline the SQL directly so the migrator has zero filesystem resolution at
// runtime (no path games, no surprises in packaged builds). The migration
// source files in `./migrations/` are kept as the human-readable form for
// review; this array is what actually runs.
const MIGRATIONS: readonly Migration[] = [
	{
		version: "0002_app_schema",
		sql: readFileSync(join(dirname(fileURLToPath(import.meta.url)), "migrations", "0002_app_schema.sql"), "utf8"),
	},
]

/**
 * Applies every unapplied migration in order. Idempotent: re-running it
 * against an already-migrated PGlite is a no-op (the `app_migrations` row
 * is the guard, and every statement in the SQL is `IF NOT EXISTS` /
 * `ON CONFLICT DO NOTHING` so even manual replay cannot corrupt state).
 *
 * Throws if any statement fails. The caller (the schema-version gate)
 * MUST refuse to boot in that case; the on-disk schema_version file is
 * not bumped until this function returns successfully.
 */
export async function applyAppMigrations(pglite: PGlite): Promise<void> {
	await pglite.exec(`
		CREATE TABLE IF NOT EXISTS app_migrations (
		  version TEXT PRIMARY KEY,
		  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`)

	const applied = new Set<string>(
		(await pglite.query<{ version: string }>(`SELECT version FROM app_migrations`)).rows.map((r) => r.version),
	)

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) continue
		await pglite.exec(migration.sql)
	}
}
