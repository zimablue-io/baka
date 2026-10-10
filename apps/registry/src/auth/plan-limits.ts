import type { PGlite } from "@electric-sql/pglite"
import { z } from "zod"

/**
 * Monetization seams (architecture §4.7, decision 3).
 *
 * The registry carries the `plan_limits` table (seeded by migration 0002)
 * and a `plan` column on Better-Auth's `organization` table (added by
 * migration 0004). Plans are server-attached: nothing in the public
 * API surface mutates them (VAL-AUTH-017). Tests / self-hosts can
 * override the seeded defaults via the `REGISTRY_SEED_PLANS` env var,
 * applied at boot through `applySeedPlans`.
 *
 * `checkPlanLimit` is the seam future publish / invite / private-pack
 * routes call before they commit a write. The verdict carries enough
 * information for the caller to render an honest 403 body naming the
 * limit (`max_private_packs`, `max_members`, or `max_registries`)
 * and the org's current plan.
 */

const SEED_PLANS_BOOT_ORDER_HINT = "REGISTRY_SEED_PLANS"

const SeedPlanEntrySchema = z.object({
	plan: z.string().min(1),
	max_private_packs: z.number().int().nonnegative(),
	max_members: z.number().int().nonnegative(),
	max_registries: z.number().int().nonnegative(),
})
const SeedPlanListSchema = z.array(SeedPlanEntrySchema)

const KNOWN_CAPABILITIES = new Set(["max_private_packs", "max_members", "max_registries"] as const)

export type PlanCapability = "max_private_packs" | "max_members" | "max_registries"

type OkVerdict = {
	ok: true
	plan: string
	capability: PlanCapability
	limit: number
	usage: number
}

type RejectVerdict = {
	ok: false
	plan: string
	capability: PlanCapability
	limit: number
	usage: number
	message: string
}

export type PlanLimitVerdict = OkVerdict | RejectVerdict

/**
 * Ensures Better-Auth's `organization` table carries the `plan` column
 * and its CHECK constraint. App migrations run BEFORE Better-Auth's
 * `ensureTables()` (so the column didn't exist on first boot), so this
 * helper is called explicitly after Better-Auth bootstraps.
 *
 * Idempotent: returns `{applied: false}` when the column and constraint
 * are already present, `{applied: true}` on a fresh install. A no-op
 * when the `organization` table does not exist (the call site should
 * still call this; the helper just exits cleanly).
 */
export async function ensureOrgPlanColumn(pglite: PGlite): Promise<{ applied: boolean }> {
	const tableExists = await pglite.query<{ exists: boolean }>(
		`SELECT EXISTS (
		   SELECT 1 FROM information_schema.tables
		    WHERE table_schema = 'public' AND table_name = 'organization'
		 ) AS exists`,
	)
	if (!tableExists.rows[0]?.exists) {
		return { applied: false }
	}

	const columnExists = await pglite.query<{ exists: boolean }>(
		`SELECT EXISTS (
		   SELECT 1 FROM information_schema.columns
		    WHERE table_schema = 'public' AND table_name = 'organization' AND column_name = 'plan'
		 ) AS exists`,
	)
	if (columnExists.rows[0]?.exists) {
		return { applied: false }
	}

	await pglite.exec(
		`ALTER TABLE "organization"
		   ADD COLUMN "plan" VARCHAR(32) NOT NULL DEFAULT 'free';
		 ALTER TABLE "organization"
		   ADD CONSTRAINT "organization_plan_check"
		   CHECK ("plan" IN ('free', 'pro', 'enterprise', 'team'));`,
	)
	return { applied: true }
}

void SEED_PLANS_BOOT_ORDER_HINT

/**
 * Applies the operator-supplied `REGISTRY_SEED_PLANS` JSON to the
 * `plan_limits` table. Each entry is upserted by `plan`; missing or
 * extra plans (vs. the migration's `free`/`pro` defaults) are kept
 * verbatim. Idempotent — re-applying the same input is a no-op.
 *
 * Throws an honest, field-naming error when the JSON is malformed or
 * an entry is missing a required field, so a misconfigured env var
 * fails fast at boot instead of silently zero-ing a limit.
 */
export async function applySeedPlans(pglite: PGlite, envValue: string | undefined): Promise<void> {
	if (envValue === undefined || envValue.length === 0) return
	let parsed: unknown
	try {
		parsed = JSON.parse(envValue)
	} catch (err) {
		throw new Error(`REGISTRY_SEED_PLANS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
	}
	const result = SeedPlanListSchema.safeParse(parsed)
	if (!result.success) {
		const missing = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
		throw new Error(`REGISTRY_SEED_PLANS failed schema validation: ${missing}`)
	}
	for (const entry of result.data) {
		await pglite.query(
			`INSERT INTO plan_limits (plan, max_private_packs, max_members, max_registries)
			   VALUES ($1, $2, $3, $4)
			 ON CONFLICT (plan) DO UPDATE
			   SET max_private_packs = EXCLUDED.max_private_packs,
			       max_members = EXCLUDED.max_members,
			       max_registries = EXCLUDED.max_registries`,
			[entry.plan, entry.max_private_packs, entry.max_members, entry.max_registries],
		)
	}
}

/**
 * Reads the org's current `plan`, the matching row from `plan_limits`,
 * and counts the org's current usage of `capability`. Returns a typed
 * verdict the caller uses to render either success or an honest 403
 * body naming the limit and the plan.
 *
 * `usage` semantics:
 *   - `max_private_packs`: `SELECT COUNT(*) FROM packs
 *     WHERE scope = $slug AND visibility = 'org' AND removed_at IS NULL`.
 *     Public packs and tombstoned packs do not count.
 *   - `max_members`: `SELECT COUNT(*) FROM member
 *     WHERE organizationId = $orgId`.
 *   - `max_registries`: reserved for the multi-registry catalog
 *     feature; counts future `catalog_subscriptions` rows.
 *
 * Throws when the org does not exist (better-auth surfaces this as
 * a 404 from `findOrgIdBySlug` upstream — the helper assumes the
 * caller already resolved the org) or when the capability is not in
 * the closed set of known plan_limits columns.
 */
export async function checkPlanLimit(pglite: PGlite, orgId: string, capability: string): Promise<PlanLimitVerdict> {
	if (!KNOWN_CAPABILITIES.has(capability as PlanCapability)) {
		throw new Error(
			`checkPlanLimit: capability '${capability}' is not a known plan_limits column (expected max_private_packs, max_members, or max_registries)`,
		)
	}
	const cap = capability as PlanCapability

	const orgRow = await pglite.query<{ plan: string; slug: string }>(
		`SELECT plan, slug FROM "organization" WHERE "id" = $1`,
		[orgId],
	)
	const org = orgRow.rows[0]
	if (!org) {
		throw new Error(`checkPlanLimit: organization ${orgId} not found`)
	}

	const limitRow = await pglite.query<Record<string, number>>(
		`SELECT max_private_packs, max_members, max_registries
		   FROM plan_limits
		  WHERE plan = $1`,
		[org.plan],
	)
	const limits = limitRow.rows[0]
	if (!limits) {
		throw new Error(`checkPlanLimit: plan_limits row for plan='${org.plan}' is missing`)
	}
	const limit = limits[cap]
	if (typeof limit !== "number") {
		throw new Error(`checkPlanLimit: plan_limits.${cap} is not a number`)
	}

	const usage = await countUsage(pglite, cap, orgId, org.slug)

	if (usage >= limit) {
		return {
			ok: false,
			plan: org.plan,
			capability: cap,
			limit,
			usage,
			message: `plan '${org.plan}' limit '${cap}' reached (usage=${usage}, limit=${limit})`,
		}
	}
	return { ok: true, plan: org.plan, capability: cap, limit, usage }
}

async function countUsage(pglite: PGlite, capability: PlanCapability, orgId: string, slug: string): Promise<number> {
	switch (capability) {
		case "max_private_packs": {
			const row = await pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count
				   FROM packs
				  WHERE scope = $1
				    AND visibility = 'org'
				    AND removed_at IS NULL`,
				[slug],
			)
			return Number.parseInt(row.rows[0]?.count ?? "0", 10)
		}
		case "max_members": {
			const row = await pglite.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count
				   FROM "member"
				  WHERE "organizationId" = $1`,
				[orgId],
			)
			return Number.parseInt(row.rows[0]?.count ?? "0", 10)
		}
		case "max_registries": {
			// Reserved for the future catalog-subscriptions feature (architecture
			// §4.3 notes catalog_subscriptions as optional). No table exists
			// yet; count is zero so the limit never triggers today.
			return 0
		}
		default: {
			// Exhaustive switch — TS narrows `capability` on each branch.
			const _exhaustive: never = capability
			throw new Error(`checkPlanLimit: unhandled capability ${_exhaustive as string}`)
		}
	}
}
