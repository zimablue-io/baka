import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyAppMigrations } from "../src/db/migrate"
import { bootSweepIngestingRows, sweepStaleIngestingRows } from "../src/worker/sweep"

/**
 * Unit tests for the boot-sweep unconditional reset and the
 * configurable per-cycle sweep threshold (VAL-PUB-028).
 *
 * User-testing round-1 finding: after a kill mid-ingest, the
 * stale `ingesting` row remained in `ingesting` for ~301 seconds
 * (5 minutes) because the stale-ingesting sweep threshold was
 * hardcoded at 5 minutes with no env override. The contract's
 * poll ceiling is 120 seconds, so the contract was violated.
 *
 * Two changes are pinned here:
 *
 *   1. BOOT SWEEP IS UNCONDITIONAL. A freshly booted process
 *      holds no in-flight jobs (no claim, no live process), so
 *      every `ingesting` row at boot is definitionally
 *      orphaned. The boot sweep resets ALL of them regardless
 *      of `updated_at`, so convergence is bounded by the worker's
 *      own poll cycle (well under the 120s contract ceiling).
 *
 *   2. THE PER-CYCLE SWEEP THRESHOLD IS ENV-CONFIGURABLE.
 *      `REGISTRY_INGEST_STALE_MS` overrides the default. The
 *      default is 120_000ms (the contract ceiling) — operators
 *      who want a more aggressive convergence bound set it lower.
 *
 * The integration of these knobs into the server bootstrap
 * (`server.ts`) and the worker runner (`runner.ts`) is exercised
 * via `ingest-worker.test.ts`'s kill-resume suite; this file
 * pins the helpers themselves.
 */

describe("stale ingesting sweep (VAL-PUB-028)", () => {
	let pglite: PGlite
	let dataDir: string

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "baka-registry-sweep-"))
		pglite = await PGlite.create(join(dataDir, "pg"))
		await applyAppMigrations(pglite)
	})

	afterEach(async () => {
		await pglite.close()
		rmSync(dataDir, { recursive: true, force: true })
		delete process.env.REGISTRY_INGEST_STALE_MS
	})

	async function pinRow(status: string, updatedAtSql: string, version: string = "v1.0.0"): Promise<string> {
		const modRes = await pglite.query<{ id: string }>(
			`INSERT INTO modules (scope, name, visibility, tier, description)
			   VALUES ('acme', 'sweep-mod', 'org', 'community-unverified', '')
			 ON CONFLICT (scope, name) DO UPDATE SET updated_at = NOW()
			 RETURNING id`,
		)
		const moduleId = modRes.rows[0]?.id ?? ""
		const vRes = await pglite.query<{ id: string }>(
			`INSERT INTO module_versions (module_id, version, commit_sha, content_hash, manifest, status, error, created_at, updated_at)
			   VALUES ($1, $4, 'abc', '', $2::jsonb, $3, NULL, ${updatedAtSql}, ${updatedAtSql})
			 RETURNING id`,
			[
				moduleId,
				JSON.stringify({
					name: "@acme/sweep-mod",
					version: "1.0.0",
					description: "x",
					actions: [],
					moduleValidators: [],
				}),
				status,
				version,
			],
		)
		return vRes.rows[0]?.id ?? ""
	}

	describe("boot sweep is unconditional (VAL-PUB-028 part 1)", () => {
		it("resets an `ingesting` row whose updated_at is FRESH (a freshly booted process owns no in-flight jobs)", async () => {
			const versionId = await pinRow("ingesting", "NOW()")
			expect(versionId.length).toBeGreaterThan(0)

			const result = await bootSweepIngestingRows(pglite)
			expect(result.rowsReset).toBe(1)

			const row = await pglite.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [
				versionId,
			])
			expect(row.rows[0]?.status).toBe("pending")
		})

		it("resets MULTIPLE `ingesting` rows regardless of their ages (every orphan is recovered at boot)", async () => {
			const fresh = await pinRow("ingesting", "NOW()", "v1.0.0")
			const recent = await pinRow("ingesting", "NOW() - interval '1 second'", "v1.0.1")
			const stale = await pinRow("ingesting", "NOW() - interval '1 hour'", "v1.0.2")

			const result = await bootSweepIngestingRows(pglite)
			expect(result.rowsReset).toBe(3)

			const rows = await pglite.query<{ id: string; status: string }>(
				`SELECT id, status FROM module_versions WHERE id = ANY($1::uuid[])`,
				[[fresh, recent, stale]],
			)
			for (const row of rows.rows) {
				expect(row.status).toBe("pending")
			}
		})

		it("does NOT touch `pending` rows (the boot sweep only recovers orphans, not new work)", async () => {
			const pending = await pinRow("pending", "NOW()", "v1.0.0")
			await bootSweepIngestingRows(pglite)
			const row = await pglite.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [pending])
			expect(row.rows[0]?.status).toBe("pending")
		})

		it("does NOT touch `ready` or `failed` rows (terminal states are durable)", async () => {
			const ready = await pinRow("ready", "NOW()", "v1.0.0")
			const failed = await pinRow("failed", "NOW()", "v1.0.1")
			await bootSweepIngestingRows(pglite)
			const rows = await pglite.query<{ id: string; status: string }>(
				`SELECT id, status FROM module_versions WHERE id = ANY($1::uuid[])`,
				[[ready, failed]],
			)
			for (const row of rows.rows) {
				expect(row.status).not.toBe("pending")
			}
		})

		it("is idempotent — re-running on a healthy data dir is a no-op", async () => {
			await pinRow("ready", "NOW()")
			const result = await bootSweepIngestingRows(pglite)
			expect(result.rowsReset).toBe(0)
		})
	})

	describe("per-cycle sweep threshold is env-configurable (VAL-PUB-028 part 2)", () => {
		it("the default sweep threshold is <= 120s (the contract ceiling)", async () => {
			// A row whose updated_at is 121s ago is older than the
			// 120s default ceiling — the sweep must reset it.
			const versionId = await pinRow("ingesting", "NOW() - interval '121 seconds'")
			const result = await sweepStaleIngestingRows(pglite)
			expect(result.staleThresholdMs).toBeLessThanOrEqual(120_000)
			expect(result.rowsReset).toBe(1)
			const row = await pglite.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [
				versionId,
			])
			expect(row.rows[0]?.status).toBe("pending")
		})

		it("a row whose updated_at is FRESHER than the threshold is NOT reset (the worker may still hold it)", async () => {
			// 1 second old, default threshold = 120s — the row is
			// not stale yet, the sweep must leave it alone.
			await pinRow("ingesting", "NOW() - interval '1 second'")
			const result = await sweepStaleIngestingRows(pglite)
			expect(result.rowsReset).toBe(0)
		})

		it("REGISTRY_INGEST_STALE_MS overrides the default threshold", async () => {
			// Pin a row 2 seconds old. With REGISTRY_INGEST_STALE_MS=1000
			// (1s) the row IS stale — the sweep must reset it.
			process.env.REGISTRY_INGEST_STALE_MS = "1000"
			const versionId = await pinRow("ingesting", "NOW() - interval '2 seconds'")
			const result = await sweepStaleIngestingRows(pglite)
			expect(result.staleThresholdMs).toBe(1_000)
			expect(result.rowsReset).toBe(1)
			const row = await pglite.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [
				versionId,
			])
			expect(row.rows[0]?.status).toBe("pending")
		})

		it("an explicit thresholdMs argument overrides both the env and the default", async () => {
			process.env.REGISTRY_INGEST_STALE_MS = "5000"
			// Pin a row 2 seconds old — stale by the 1s override,
			// not stale by the 5s env default.
			await pinRow("ingesting", "NOW() - interval '2 seconds'")
			const result = await sweepStaleIngestingRows(pglite, { thresholdMs: 1_000 })
			expect(result.staleThresholdMs).toBe(1_000)
			expect(result.rowsReset).toBe(1)
		})

		it("a malformed REGISTRY_INGEST_STALE_MS falls back to the default (no boot crash)", async () => {
			process.env.REGISTRY_INGEST_STALE_MS = "not-a-number"
			// The default (120s) applies — the 121s-old row IS stale.
			const versionId = await pinRow("ingesting", "NOW() - interval '121 seconds'")
			const result = await sweepStaleIngestingRows(pglite)
			expect(result.staleThresholdMs).toBeLessThanOrEqual(120_000)
			expect(result.rowsReset).toBe(1)
			const row = await pglite.query<{ status: string }>(`SELECT status FROM module_versions WHERE id = $1`, [
				versionId,
			])
			expect(row.rows[0]?.status).toBe("pending")
		})
	})
})
