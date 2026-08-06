import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Schema version (architecture §8 decision 28, forward-only).
 *
 * The registry data dir records a `schema_version` as a single integer
 * string in `<dataDir>/schema_version`. Bumping this constant is the only
 * way to change the on-disk shape; migrations between versions run at boot
 * in `applyMigrations`.
 *
 * Boot rules:
 *   - data dir absent or unreadable → treated as fresh (write current).
 *   - existing version < current → run forward migrations, then write current.
 *   - existing version === current → no-op.
 *   - existing version > current → REFUSE boot. Migrations are forward-only
 *     and an older binary cannot know how to read newer data.
 */

export const CURRENT_SCHEMA_VERSION = "1"

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
 */
export function ensureSchemaVersion(dataDir: string): EnsureSchemaVersionResult {
	if (!existsSync(dataDir)) {
		mkdirSync(dataDir, { recursive: true })
	}

	const existing = readSchemaFile(dataDir)
	if (existing === null) {
		writeFileSync(join(dataDir, SCHEMA_FILE), `${CURRENT_SCHEMA_VERSION}\n`, "utf8")
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

	applyMigrations(dataDir, existing)
	writeFileSync(join(dataDir, SCHEMA_FILE), `${CURRENT_SCHEMA_VERSION}\n`, "utf8")
	return { ok: true, version: CURRENT_SCHEMA_VERSION }
}

/**
 * Forward-only migration hook. Called when the recorded version is older
 * than `CURRENT_SCHEMA_VERSION`. Each future bump adds a branch here.
 *
 * The scaffold milestone has no schema-changing tables yet (the data
 * layer feature lands in the next milestone), so this is a no-op for
 * version 1.
 */
function applyMigrations(_dataDir: string, _from: string): void {
	// Intentionally empty. Future: switch (_from) { case "1": /* … */ break }
}
