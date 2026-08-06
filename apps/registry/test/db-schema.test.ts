import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDatabase } from "../src/db/client"
import { CURRENT_SCHEMA_VERSION } from "../src/schema-version"

/**
 * Architecture §4.3: the registry app tables (modules, module_versions,
 * artifacts, screening_results, plan_limits) must exist with the documented
 * columns, NOT NULL, UNIQUE, FK, and CHECK constraints after migrations run.
 *
 * This test boots a real PGlite in a tmp data dir (no mocks — verified
 * dependency facts mandate real PGlite for every test).
 */

let dataDir: string
let pgliteDir: string

beforeEach(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "baka-registry-db-schema-"))
	pgliteDir = join(dataDir, "pg")
})

afterEach(async () => {
	rmSync(dataDir, { recursive: true, force: true })
})

interface ColumnRow {
	column_name: string
	data_type: string
	is_nullable: string
	column_default: string | null
}

interface ConstraintRow {
	constraint_name: string
	constraint_type: string
	table_name: string
}

async function listColumns(pglite: import("@electric-sql/pglite").PGlite, table: string): Promise<ColumnRow[]> {
	const result = await pglite.query<ColumnRow>(
		`SELECT column_name, data_type, is_nullable, column_default
		   FROM information_schema.columns
		  WHERE table_schema = 'public' AND table_name = $1
		  ORDER BY ordinal_position`,
		[table],
	)
	return result.rows
}

async function listConstraints(pglite: import("@electric-sql/pglite").PGlite, table: string): Promise<ConstraintRow[]> {
	const result = await pglite.query<ConstraintRow>(
		`SELECT constraint_name, constraint_type, table_name
		   FROM information_schema.table_constraints
		  WHERE table_schema = 'public' AND table_name = $1
		  ORDER BY constraint_name`,
		[table],
	)
	return result.rows
}

describe("registry app schema (architecture §4.3)", () => {
	it("CURRENT_SCHEMA_VERSION is '5' (publish endpoint, created_by text)", () => {
		expect(CURRENT_SCHEMA_VERSION).toBe("5")
	})

	it("creates the five app tables after boot", async () => {
		const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
		try {
			const result = await handle.pglite.query<{ table_name: string }>(
				`SELECT table_name FROM information_schema.tables
				  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
				  ORDER BY table_name`,
			)
			const names = result.rows.map((r) => r.table_name)
			expect(names).toEqual(
				expect.arrayContaining(["modules", "module_versions", "artifacts", "screening_results", "plan_limits"]),
			)
		} finally {
			await handle.close()
		}
	})

	describe("modules table", () => {
		it("has the documented columns with correct nullability", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const cols = await listColumns(handle.pglite, "modules")
				const byName = new Map(cols.map((c) => [c.column_name, c]))
				expect(byName.get("id")?.data_type).toBe("uuid")
				expect(byName.get("id")?.is_nullable).toBe("NO")
				expect(byName.get("scope")?.data_type).toBe("character varying")
				expect(byName.get("scope")?.is_nullable).toBe("NO")
				expect(byName.get("name")?.data_type).toBe("character varying")
				expect(byName.get("name")?.is_nullable).toBe("NO")
				expect(byName.get("visibility")?.data_type).toBe("character varying")
				expect(byName.get("visibility")?.is_nullable).toBe("NO")
				expect(byName.get("tier")?.data_type).toBe("character varying")
				expect(byName.get("tier")?.is_nullable).toBe("NO")
				expect(byName.get("description")?.is_nullable).toBe("NO")
				expect(byName.get("created_at")?.is_nullable).toBe("NO")
				expect(byName.get("updated_at")?.is_nullable).toBe("NO")
			} finally {
				await handle.close()
			}
		})

		it("enforces the (scope, name) UNIQUE constraint", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				await handle.pglite.query(
					`INSERT INTO modules (scope, name, visibility, tier, description)
					 VALUES ('acme', 'foo', 'org', 'community-unverified', 'first')`,
				)
				await expect(
					handle.pglite.query(
						`INSERT INTO modules (scope, name, visibility, tier, description)
						 VALUES ('acme', 'foo', 'org', 'community-unverified', 'dup')`,
					),
				).rejects.toThrow(/modules_scope_name_uniq|duplicate key|unique constraint/i)
			} finally {
				await handle.close()
			}
		})

		it("enforces the visibility CHECK constraint (public | org)", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				await expect(
					handle.pglite.query(
						`INSERT INTO modules (scope, name, visibility, tier, description)
						 VALUES ('acme', 'foo', 'private', 'community-unverified', 'bad visibility')`,
					),
				).rejects.toThrow(/modules_visibility_check|check constraint/i)
			} finally {
				await handle.close()
			}
		})

		it("enforces the tier CHECK constraint (the documented set)", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				await expect(
					handle.pglite.query(
						`INSERT INTO modules (scope, name, visibility, tier, description)
						 VALUES ('acme', 'foo', 'org', 'bogus-tier', 'bad tier')`,
					),
				).rejects.toThrow(/modules_tier_check|check constraint/i)
			} finally {
				await handle.close()
			}
		})
	})

	describe("module_versions table", () => {
		it("has the documented columns with FK to modules", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const cols = await listColumns(handle.pglite, "module_versions")
				const byName = new Map(cols.map((c) => [c.column_name, c]))
				expect(byName.get("module_id")?.is_nullable).toBe("NO")
				expect(byName.get("version")?.is_nullable).toBe("NO")
				expect(byName.get("commit_sha")?.is_nullable).toBe("NO")
				expect(byName.get("content_hash")?.is_nullable).toBe("NO")
				expect(byName.get("manifest")?.data_type).toBe("jsonb")
				expect(byName.get("manifest")?.is_nullable).toBe("NO")
				expect(byName.get("status")?.is_nullable).toBe("NO")

				const constraints = await listConstraints(handle.pglite, "module_versions")
				const fks = constraints.filter((c) => c.constraint_type === "FOREIGN KEY")
				expect(fks.length).toBeGreaterThan(0)
			} finally {
				await handle.close()
			}
		})

		it("enforces the (module_id, version) UNIQUE constraint", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const mod = await handle.pglite.query<{ id: string }>(
					`INSERT INTO modules (scope, name, visibility, tier, description)
					 VALUES ('acme', 'foo', 'org', 'community-unverified', 'desc')
					 RETURNING id`,
				)
				const moduleId = mod.rows[0]?.id
				expect(moduleId).toBeTruthy()
				await handle.pglite.query(
					`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status)
					 VALUES ($1, '1.0.0', 'abc', 'h1', '{}'::jsonb, 'pending')`,
					[moduleId],
				)
				await expect(
					handle.pglite.query(
						`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status)
						 VALUES ($1, '1.0.0', 'def', 'h2', '{}'::jsonb, 'pending')`,
						[moduleId],
					),
				).rejects.toThrow(/module_versions_module_id_version_uniq|duplicate key|unique constraint/i)
			} finally {
				await handle.close()
			}
		})

		it("enforces the status CHECK constraint (pending|ingesting|ready|failed)", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const mod = await handle.pglite.query<{ id: string }>(
					`INSERT INTO modules (scope, name, visibility, tier, description)
					 VALUES ('acme', 'foo', 'org', 'community-unverified', 'desc')
					 RETURNING id`,
				)
				await expect(
					handle.pglite.query(
						`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status)
						 VALUES ($1, '1.0.0', 'abc', 'h1', '{}'::jsonb, 'bogus')`,
						[mod.rows[0]?.id],
					),
				).rejects.toThrow(/module_versions_status_check|check constraint/i)
			} finally {
				await handle.close()
			}
		})
	})

	describe("artifacts table", () => {
		it("has the documented columns with FK to module_versions", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const cols = await listColumns(handle.pglite, "artifacts")
				const byName = new Map(cols.map((c) => [c.column_name, c]))
				expect(byName.get("version_id")?.is_nullable).toBe("NO")
				expect(byName.get("kind")?.is_nullable).toBe("NO")
				expect(byName.get("path")?.is_nullable).toBe("NO")
				expect(byName.get("size")?.is_nullable).toBe("NO")
				expect(byName.get("sha256")?.is_nullable).toBe("NO")
				const constraints = await listConstraints(handle.pglite, "artifacts")
				expect(constraints.some((c) => c.constraint_type === "FOREIGN KEY")).toBe(true)
			} finally {
				await handle.close()
			}
		})

		it("enforces the kind CHECK constraint (tarball|preview)", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				await expect(
					handle.pglite.query(
						`INSERT INTO artifacts (version_id, kind, path, size, sha256)
						 VALUES ('00000000-0000-0000-0000-000000000000', 'unknown', 'x', 1, 'h')`,
					),
				).rejects.toThrow(/artifacts_kind_check|check constraint/i)
			} finally {
				await handle.close()
			}
		})
	})

	describe("screening_results table", () => {
		it("has the documented columns and one-result-per-version UNIQUE", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const cols = await listColumns(handle.pglite, "screening_results")
				const byName = new Map(cols.map((c) => [c.column_name, c]))
				expect(byName.get("version_id")?.is_nullable).toBe("NO")
				expect(byName.get("verdict")?.is_nullable).toBe("NO")
				expect(byName.get("static_scan")?.data_type).toBe("jsonb")
				expect(byName.get("dry_run")?.data_type).toBe("jsonb")
				const constraints = await listConstraints(handle.pglite, "screening_results")
				expect(constraints.some((c) => c.constraint_type === "UNIQUE")).toBe(true)
			} finally {
				await handle.close()
			}
		})

		it("enforces the verdict CHECK constraint (screened|unverified|failed)", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				await expect(
					handle.pglite.query(
						`INSERT INTO screening_results (version_id, verdict)
						 VALUES ('00000000-0000-0000-0000-000000000000', 'bogus')`,
					),
				).rejects.toThrow(/screening_results_verdict_check|check constraint/i)
			} finally {
				await handle.close()
			}
		})
	})

	describe("plan_limits table", () => {
		it("uses plan as primary key with the documented columns", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const cols = await listColumns(handle.pglite, "plan_limits")
				const byName = new Map(cols.map((c) => [c.column_name, c]))
				expect(byName.get("plan")?.is_nullable).toBe("NO")
				expect(byName.get("max_private_modules")?.is_nullable).toBe("NO")
				expect(byName.get("max_members")?.is_nullable).toBe("NO")
				expect(byName.get("max_registries")?.is_nullable).toBe("NO")
				const constraints = await listConstraints(handle.pglite, "plan_limits")
				expect(constraints.some((c) => c.constraint_type === "PRIMARY KEY")).toBe(true)
			} finally {
				await handle.close()
			}
		})

		it("seeds free/pro plan rows at boot so plan-limit enforcement has a lookup", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const rows = await handle.pglite.query<{ plan: string }>(`SELECT plan FROM plan_limits ORDER BY plan`)
				expect(rows.rows.map((r) => r.plan)).toEqual(["free", "pro"])
			} finally {
				await handle.close()
			}
		})
	})

	describe("Drizzle ORM schema definitions", () => {
		it("exposes the five tables via the drizzle client (round-trips an INSERT)", async () => {
			const handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })
			try {
				const inserted = await handle.db
					.insert(handle.schema.modules)
					.values({
						scope: "acme",
						name: "via-drizzle",
						visibility: "org",
						tier: "community-unverified",
						description: "round-trip",
					})
					.returning({ id: handle.schema.modules.id })
				expect(inserted[0]?.id).toBeTruthy()

				const fetched = await handle.db.query.modules.findFirst({
					where: (m, { eq }) => eq(m.id, inserted[0]?.id),
				})
				expect(fetched?.scope).toBe("acme")
				expect(fetched?.name).toBe("via-drizzle")
				expect(fetched?.visibility).toBe("org")
			} finally {
				await handle.close()
			}
		})
	})
})
