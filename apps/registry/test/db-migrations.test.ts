import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDatabase } from "../src/db/client"
import { CURRENT_SCHEMA_VERSION, ensureSchemaVersion, readSchemaVersion } from "../src/schema-version"

/**
 * Architecture §8 decision 28: forward-only migrations. An old binary
 * started against a NEWER schema version refuses to boot with an honest
 * error naming the mismatch. The data layer bumps CURRENT_SCHEMA_VERSION
 * from 1 → 2; that bump is exercised here end-to-end against a real PGlite.
 */

function makeTmpDataDir(): string {
	return mkdtempSync(join(tmpdir(), "baka-registry-db-migrations-"))
}

let dataDir: string
let pgliteDir: string

beforeEach(() => {
	dataDir = makeTmpDataDir()
	pgliteDir = join(dataDir, "pg")
})

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true })
})

describe("ensureSchemaVersion (data-layer version bump)", () => {
	it("CURRENT_SCHEMA_VERSION is the bumped value '5' (publish endpoint, created_by text)", () => {
		expect(CURRENT_SCHEMA_VERSION).toBe("5")
	})

	it("writes schema_version='5' on a fresh data dir after migrations", async () => {
		const result = await ensureSchemaVersion({ dataDir, pgliteDir })
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.version).toBe("5")
		expect(readSchemaVersion(dataDir)).toBe("5")
	})

	it("is idempotent: a second call after migrations is a no-op", async () => {
		const first = await ensureSchemaVersion({ dataDir, pgliteDir })
		expect(first.ok).toBe(true)
		const second = await ensureSchemaVersion({ dataDir, pgliteDir })
		expect(second.ok).toBe(true)
		if (second.ok) expect(second.version).toBe("5")
	})

	it("migrates a v1 data dir in place and applies the app schema", async () => {
		// Seed a v1 data dir (the scaffold milestone's value).
		writeFileSync(join(dataDir, "schema_version"), "1\n", "utf8")
		expect(readSchemaVersion(dataDir)).toBe("1")

		const result = await ensureSchemaVersion({ dataDir, pgliteDir })
		expect(result.ok).toBe(true)
		expect(readSchemaVersion(dataDir)).toBe("5")

		// After migration, the app tables exist.
		const db = await createDatabase({ dataDir: pgliteDir, startSocket: false })
		try {
			const tables = await db.pglite.query<{ table_name: string }>(
				`SELECT table_name FROM information_schema.tables
				  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
			)
			const names = tables.rows.map((r) => r.table_name)
			expect(names).toEqual(
				expect.arrayContaining(["modules", "module_versions", "artifacts", "screening_results", "plan_limits"]),
			)
		} finally {
			await db.close()
		}
	})

	it("refuses to boot when the data dir has a newer schema_version than the binary supports", async () => {
		const newerVersion = String(Number.parseInt(CURRENT_SCHEMA_VERSION, 10) + 1)
		writeFileSync(join(dataDir, "schema_version"), `${newerVersion}\n`, "utf8")

		const result = await ensureSchemaVersion({ dataDir, pgliteDir })
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error).toContain(newerVersion)
			expect(result.error).toContain(CURRENT_SCHEMA_VERSION)
		}

		// The newer-versioned file is preserved (forward-only).
		expect(readSchemaVersion(dataDir)).toBe(newerVersion)

		// The data dir must NOT have been migrated (no app tables created).
		// The pg subdir either does not exist, or exists but contains no app tables.
		if (existsSync(pgliteDir)) {
			const db = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const tables = await db.pglite.query<{ table_name: string }>(
					`SELECT table_name FROM information_schema.tables
					  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
				)
				const names = tables.rows.map((r) => r.table_name)
				expect(names).not.toContain("modules")
			} finally {
				await db.close()
			}
		}
	})

	it("re-running the migrator against an already-migrated dir is a no-op (no duplicate rows, no errors)", async () => {
		// First run creates plan_limits seed rows.
		const first = await createDatabase({ dataDir: pgliteDir, startSocket: false })
		await first.close()

		// Second open must see the same plan rows (idempotent).
		const second = await createDatabase({ dataDir: pgliteDir, startSocket: false })
		try {
			const rows = await second.pglite.query<{ plan: string }>(`SELECT plan FROM plan_limits ORDER BY plan`)
			expect(rows.rows.map((r) => r.plan)).toEqual(["free", "pro"])
		} finally {
			await second.close()
		}
	})

	it("records an internal migration tracking row only once (idempotency guard)", async () => {
		const first = await createDatabase({ dataDir: pgliteDir, startSocket: false })
		await first.close()

		const second = await createDatabase({ dataDir: pgliteDir, startSocket: false })
		try {
			const rows = await second.pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM app_migrations WHERE version = $1`,
				["0002_app_schema"],
			)
			expect(rows.rows[0]?.count).toBe("1")
		} finally {
			await second.close()
		}
	})

	it("schema_version file content is exactly the version string + newline", async () => {
		await ensureSchemaVersion({ dataDir, pgliteDir })
		const raw = readFileSync(join(dataDir, "schema_version"), "utf8")
		expect(raw).toBe("5\n")
	})
})
