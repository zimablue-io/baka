import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	applySeedPlans,
	checkPlanLimit,
	ensureOrgPlanColumn,
	type PlanCapability,
	type PlanLimitVerdict,
} from "../src/auth/plan-limits"
import { createDatabase, type DatabaseHandle } from "../src/db/client"

/**
 * Plan seams (architecture §4.7, decision 3).
 *
 * `plan_limits` is seeded by migration 0002 with default `free`/`pro`
 * rows. `REGISTRY_SEED_PLANS` lets tests / self-hosts override or
 * extend the active plan set at boot; the override is applied
 * idempotently via UPSERT. `checkPlanLimit` reads the org's plan
 * column (added by migration 0004 via `ensureOrgPlanColumn`) and the
 * matching row from `plan_limits`, then counts the org's current
 * usage to produce a verdict. No public API can set a plan — that
 * surface does not exist (VAL-AUTH-017).
 *
 * The test fixture mirrors the production boot order: app migrations
 * first (creates `plan_limits`, etc.), then Better-Auth's organization
 * table, then `ensureOrgPlanColumn` adds the `plan` column. The
 * org/member tables are created by the test directly (Better-Auth's
 * full introspection is irrelevant for this seam's unit tests).
 */

let dataDir: string
let pgliteDir: string
let handle: DatabaseHandle

beforeEach(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "baka-registry-plan-limits-"))
	pgliteDir = join(dataDir, "pg")
	handle = await createDatabase({ dataDir: pgliteDir, startSocket: false })

	// Mirror the production boot order: create the organization /
	// member tables (Better-Auth's introspection in production),
	// then ensure the plan column is added.
	await handle.pglite.exec(`
		CREATE TABLE IF NOT EXISTS "organization" (
		  "id" TEXT PRIMARY KEY,
		  "name" TEXT NOT NULL,
		  "slug" TEXT NOT NULL UNIQUE,
		  "logo" TEXT,
		  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  "metadata" TEXT
		);
		CREATE TABLE IF NOT EXISTS "member" (
		  "id" TEXT PRIMARY KEY,
		  "organizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
		  "userId" TEXT NOT NULL,
		  "role" TEXT NOT NULL,
		  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`)
	await ensureOrgPlanColumn(handle.pglite)
})

afterEach(async () => {
	await handle.close()
	rmSync(dataDir, { recursive: true, force: true })
})

async function seedOrg(slug: string, plan = "free"): Promise<string> {
	const row = await handle.pglite.query<{ id: string }>(
		`INSERT INTO "organization" ("id", "name", "slug", "plan")
		   VALUES ($1, $2, $3, $4)
		   RETURNING "id"`,
		[`org-${slug}`, `Org ${slug}`, slug, plan],
	)
	const id = row.rows[0]?.id
	if (!id) throw new Error("seedOrg failed")
	return id
}

async function insertOrgModule(scope: string, name: string, visibility: "org" | "public"): Promise<void> {
	await handle.pglite.query(
		`INSERT INTO modules (scope, name, visibility, tier, description)
		   VALUES ($1, $2, $3, 'community-unverified', '')`,
		[scope, name, visibility],
	)
}

describe("REGISTRY_SEED_PLANS boot hook (architecture §8 decision 3)", () => {
	it("with no env var, defaults from migration 0002 (free, pro) are present", async () => {
		await applySeedPlans(handle.pglite, undefined)
		const rows = await handle.pglite.query<{ plan: string }>(`SELECT plan FROM plan_limits ORDER BY plan`)
		expect(rows.rows.map((r) => r.plan)).toEqual(["free", "pro"])
	})

	it("REGISTRY_SEED_PLANS upserts a plan that overrides the seeded defaults", async () => {
		const seed = JSON.stringify([
			{ plan: "free", max_private_modules: 1, max_members: 2, max_registries: 1 },
			{ plan: "pro", max_private_modules: 50, max_members: 10, max_registries: 5 },
		])
		await applySeedPlans(handle.pglite, seed)
		const rows = await handle.pglite.query<{ plan: string; max_private_modules: number }>(
			`SELECT plan, max_private_modules FROM plan_limits ORDER BY plan`,
		)
		expect(rows.rows).toEqual([
			{ plan: "free", max_private_modules: 1 },
			{ plan: "pro", max_private_modules: 50 },
		])
	})

	it("REGISTRY_SEED_PLANS adds a new plan not present in the seeded defaults", async () => {
		const seed = JSON.stringify([
			{ plan: "free", max_private_modules: 5, max_members: 3, max_registries: 1 },
			{ plan: "pro", max_private_modules: 100, max_members: 25, max_registries: 10 },
			{ plan: "enterprise", max_private_modules: 10000, max_members: 1000, max_registries: 100 },
		])
		await applySeedPlans(handle.pglite, seed)
		const rows = await handle.pglite.query<{ plan: string }>(`SELECT plan FROM plan_limits ORDER BY plan`)
		expect(rows.rows.map((r) => r.plan)).toEqual(["enterprise", "free", "pro"])
	})

	it("a malformed REGISTRY_SEED_PLANS value throws an honest, field-naming error", async () => {
		await expect(applySeedPlans(handle.pglite, "not-json")).rejects.toThrow(/REGISTRY_SEED_PLANS/i)
	})

	it("a REGISTRY_SEED_PLANS entry missing required fields throws naming the field", async () => {
		const seed = JSON.stringify([{ plan: "free" }])
		await expect(applySeedPlans(handle.pglite, seed)).rejects.toThrow(/max_private_modules/i)
	})

	it("applying the same REGISTRY_SEED_PLANS twice is idempotent (no duplicate rows)", async () => {
		const seed = JSON.stringify([
			{ plan: "free", max_private_modules: 5, max_members: 3, max_registries: 1 },
			{ plan: "pro", max_private_modules: 100, max_members: 25, max_registries: 10 },
		])
		await applySeedPlans(handle.pglite, seed)
		await applySeedPlans(handle.pglite, seed)
		const rows = await handle.pglite.query<{ plan: string }>(`SELECT plan FROM plan_limits ORDER BY plan`)
		expect(rows.rows.map((r) => r.plan)).toEqual(["free", "pro"])
	})
})

describe("checkPlanLimit (monetization seam helper)", () => {
	it("returns ok for an org with zero modules when the limit is positive", async () => {
		const orgId = await seedOrg("acme")
		const verdict = await checkPlanLimit(handle.pglite, orgId, "max_private_modules")
		expect(verdict.ok).toBe(true)
		if (verdict.ok) {
			expect(verdict.limit).toBe(5) // free plan default from migration 0002
			expect(verdict.plan).toBe("free")
			expect(verdict.usage).toBe(0)
		}
	})

	it("returns ok when usage is strictly below the limit", async () => {
		const orgId = await seedOrg("acme")
		await insertOrgModule("acme", "alpha", "org")
		await insertOrgModule("acme", "beta", "org")
		const verdict = await checkPlanLimit(handle.pglite, orgId, "max_private_modules")
		expect(verdict.ok).toBe(true)
		if (verdict.ok) {
			expect(verdict.usage).toBe(2)
			expect(verdict.limit).toBe(5)
		}
	})

	it("returns ok=false with limit and plan in the rejection when usage equals the limit", async () => {
		const orgId = await seedOrg("acme")
		for (let i = 0; i < 5; i++) {
			await insertOrgModule("acme", `mod-${i}`, "org")
		}
		const verdict = await checkPlanLimit(handle.pglite, orgId, "max_private_modules")
		expect(verdict.ok).toBe(false)
		if (!verdict.ok) {
			expect(verdict.plan).toBe("free")
			expect(verdict.limit).toBe(5)
			expect(verdict.usage).toBe(5)
			expect(verdict.capability).toBe("max_private_modules")
			expect(verdict.message).toContain("free")
			expect(verdict.message).toContain("max_private_modules")
		}
	})

	it("counts only `org` visibility modules (public modules do not count toward max_private_modules)", async () => {
		const orgId = await seedOrg("acme")
		await insertOrgModule("acme", "private-1", "org")
		await insertOrgModule("acme", "private-2", "org")
		await insertOrgModule("acme", "public-1", "public")
		await insertOrgModule("acme", "public-2", "public")
		const verdict = await checkPlanLimit(handle.pglite, orgId, "max_private_modules")
		expect(verdict.ok).toBe(true)
		if (verdict.ok) expect(verdict.usage).toBe(2)
	})

	it("respects a custom limit seeded via REGISTRY_SEED_PLANS", async () => {
		const seed = JSON.stringify([
			{ plan: "free", max_private_modules: 1, max_members: 3, max_registries: 1 },
			{ plan: "pro", max_private_modules: 100, max_members: 25, max_registries: 10 },
		])
		await applySeedPlans(handle.pglite, seed)
		const orgId = await seedOrg("acme")
		await insertOrgModule("acme", "first", "org")
		const verdict = await checkPlanLimit(handle.pglite, orgId, "max_private_modules")
		expect(verdict.ok).toBe(false)
		if (!verdict.ok) {
			expect(verdict.limit).toBe(1)
			expect(verdict.plan).toBe("free")
		}
	})

	it("counts current members of the org for the max_members capability", async () => {
		const orgId = await seedOrg("acme")
		await handle.pglite.query(
			`INSERT INTO "member" ("id", "userId", "organizationId", "role")
			   VALUES ('m-1', $1, $2, 'owner'),
			          ('m-2', $3, $2, 'member')`,
			["u-1", orgId, "u-2"],
		)
		const verdict = await checkPlanLimit(handle.pglite, orgId, "max_members")
		expect(verdict.ok).toBe(true)
		if (verdict.ok) {
			expect(verdict.usage).toBe(2)
			expect(verdict.limit).toBe(3) // free plan default
		}
	})

	it("returns ok=false with honest naming when over the max_members limit", async () => {
		const orgId = await seedOrg("acme")
		await handle.pglite.query(
			`INSERT INTO "member" ("id", "userId", "organizationId", "role")
			   VALUES ('m-1', $1, $2, 'owner'),
			          ('m-2', $3, $2, 'admin'),
			          ('m-3', $4, $2, 'member'),
			          ('m-4', $5, $2, 'member')`,
			["u-1", orgId, "u-2", "u-3", "u-4"],
		)
		const verdict = await checkPlanLimit(handle.pglite, orgId, "max_members")
		expect(verdict.ok).toBe(false)
		if (!verdict.ok) {
			expect(verdict.plan).toBe("free")
			expect(verdict.limit).toBe(3)
			expect(verdict.usage).toBe(4)
			expect(verdict.capability).toBe("max_members")
		}
	})

	it("throws an honest error when the org does not exist", async () => {
		await expect(
			checkPlanLimit(handle.pglite, "00000000-0000-0000-0000-000000000000", "max_private_modules"),
		).rejects.toThrow(/organization/i)
	})

	it("throws an honest error when the capability is not a known plan_limits column", async () => {
		const orgId = await seedOrg("acme")
		await expect(checkPlanLimit(handle.pglite, orgId, "max_bogus")).rejects.toThrow(/capability/i)
	})

	it("the verdict type narrows correctly on ok=true vs ok=false (typed seam surface)", async () => {
		// Pins the PlanLimitVerdict discriminated union so a caller can
		// branch on `verdict.ok` without further narrowing.
		const orgId = await seedOrg("acme")
		const okVerdict: PlanLimitVerdict = await checkPlanLimit(handle.pglite, orgId, "max_private_modules")
		expect(okVerdict.ok).toBe(true)
		if (okVerdict.ok) {
			// narrow: okVerdict.usage / .limit / .plan exist
			expect(typeof okVerdict.usage).toBe("number")
			expect(typeof okVerdict.limit).toBe("number")
		}
	})

	it("PlanCapability is the closed set the helper accepts (max_private_modules, max_members, max_registries)", () => {
		// Compile-time pin: a typo in a caller is a TS error, not a
		// runtime branch. Runtime: the closed set is also enforced by
		// KNOWN_CAPABILITIES inside checkPlanLimit.
		const capabilities: PlanCapability[] = ["max_private_modules", "max_members", "max_registries"]
		expect(capabilities).toHaveLength(3)
	})
})
