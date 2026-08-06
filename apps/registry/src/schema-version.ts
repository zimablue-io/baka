import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { applyAppMigrations } from "./db/migrate"

/**
 * Schema version (architecture §8 decision 28, forward-only).
 *
 * The registry data dir records a `schema_version` as a single integer
 * string in `<dataDir>/schema_version`. Bumping this constant is the only
 * way to change the on-disk shape; migrations between versions run at boot
 * via `applyAppMigrations`.
 *
 * Boot rules:
 *   - data dir absent or unreadable → treated as fresh (write current).
 *   - existing version < current → open PGlite, run unapplied migrations,
 *     then write current.
 *   - existing version === current → no-op.
 *   - existing version > current → REFUSE boot. Migrations are forward-only
 *     and an older binary cannot know how to read newer data.
 *
 * Version history:
 *   - 1: scaffold (no app tables; just the on-disk version file).
 *   - 2: data layer — modules, module_versions, artifacts, screening_results,
 *        plan_limits (architecture §4.3) + the internal app_migrations
 *        tracking table.
 *   - 3: auth layer — Better-Auth manages its own tables (user, session,
 *        account, verification, organization, member, invitation, apikey)
 *        through its Kysely migration path. They coexist with the app
 *        schema. The marker migration `0003_auth_marker.sql` records the
 *        version; the actual auth-table DDL is applied at boot by
 *        `auth/ensure-auth-tables.ts` (idempotent introspection via
 *        Better-Auth's `getMigrations`).
 *   - 4: monetization seams — `organization.plan` column added
 *        (architecture §4.7, decision 3) so the registry can enforce
 *        per-plan limits. `plan_limits` was already seeded by 0002;
 *        this migration only extends the auth-side schema. The column
 *        defaults to `free` and is server-attached: no public API
 *        surface can mutate it (VAL-AUTH-017).
 */

export const CURRENT_SCHEMA_VERSION = "4"

const SCHEMA_FILE = "schema_version"

type EnsureSchemaVersionResult = { ok: true; version: string } | { ok: false; error: string }

function readSchemaFile(dataDir: string): string | null {
	const path = join(dataDir, SCHEMA_FILE)
	if (!existsSync(path)) return null
	const raw = readFileSync(path, "utf8").trim()
	return raw.length > 0 ? raw : null
}

/**
 * Reads the recorded schema version from the data dir. Returns `null`
 * when the file is absent or empty (fresh install).
 */
export function readSchemaVersion(dataDir: string): string | null {
	return readSchemaFile(dataDir)
}

function compareVersions(a: string, b: string): number {
	const an = Number.parseInt(a, 10)
	const bn = Number.parseInt(b, 10)
	if (Number.isNaN(an) || Number.isNaN(bn)) {
		throw new Error(`schema_version must be an integer (got a=${a}, b=${b})`)
	}
	if (an === bn) return 0
	return an < bn ? -1 : 1
}

/**
 * Runs the schema-version gate at boot. Creates the data dir, runs any
 * forward migrations from the recorded version up to `CURRENT_SCHEMA_VERSION`,
 * and writes the current version on success.
 *
 * Returns `{ ok: false, error }` when the recorded version is NEWER than
 * the binary supports — the caller MUST refuse to boot (forward-only).
 *
 * The PGlite at `pgliteDir` is opened transiently to run migrations and
 * closed before returning. The HTTP server binds only after this resolves,
 * so a migration failure keeps the port free.
 */
export async function ensureSchemaVersion(opts: {
	dataDir: string
	pgliteDir: string
}): Promise<EnsureSchemaVersionResult> {
	if (!existsSync(opts.dataDir)) {
		mkdirSync(opts.dataDir, { recursive: true })
	}

	const existing = readSchemaFile(opts.dataDir)
	if (existing === null) {
		// Fresh data dir — open PGlite, apply migrations, write the gate file.
		await runMigrations(opts.pgliteDir)
		writeFileSync(join(opts.dataDir, SCHEMA_FILE), `${CURRENT_SCHEMA_VERSION}\n`, "utf8")
		return { ok: true, version: CURRENT_SCHEMA_VERSION }
	}

	const cmp = compareVersions(existing, CURRENT_SCHEMA_VERSION)
	if (cmp === 0) return { ok: true, version: CURRENT_SCHEMA_VERSION }

	if (cmp > 0) {
		return {
			ok: false,
			error:
				`registry data dir schema_version=${existing} is NEWER than this binary supports (schema_version=${CURRENT_SCHEMA_VERSION}). ` +
				`Migrations are forward-only; upgrade the binary before booting against this data dir.`,
		}
	}

	// Older version: apply migrations forward, then write the gate file.
	// The migration runner is idempotent (it skips already-applied migrations)
	// so re-running it after a crash leaves the data dir in a consistent state.
	await runMigrations(opts.pgliteDir)
	writeFileSync(join(opts.dataDir, SCHEMA_FILE), `${CURRENT_SCHEMA_VERSION}\n`, "utf8")
	return { ok: true, version: CURRENT_SCHEMA_VERSION }
}

async function runMigrations(pgliteDir: string): Promise<void> {
	const pglite = await PGlite.create(pgliteDir)
	try {
		await applyAppMigrations(pglite)
	} finally {
		await pglite.close()
	}
}
