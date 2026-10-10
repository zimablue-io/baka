import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { authedFetch, buildOrgTestStack, createApiKey, type OrgTestStack, signUp } from "./auth-orgs-fixture"

/**
 * max_members plan-limit enforcement on the org invite + accept flow
 * (VAL-SELF-006 step 3 — user-testing round-1 fix).
 *
 * The publish route already enforces `max_private_packs` via
 * `checkPlanLimit()` (apps/registry/src/publish/routes.ts). The org
 * invite + accept-invitation routes did NOT — an over-limit invite
 * returned 200, the member accepted, and the org ended at 3/2 members
 * on a free plan (max_members=2). Round-1 user-testing caught the
 * hole (VAL-SELF-006 step 3).
 *
 * The fix mirrors the publish-route pattern exactly: wire Better-Auth's
 * `organizationHooks.beforeCreateInvitation` and
 * `organizationHooks.beforeAcceptInvitation` to call
 * `checkPlanLimit(... "max_members")` and throw a 403 APIError naming
 * the limit and plan when over. The hooks fire for every code path
 * that lands on Better-Auth's organization plugin — `/v1/orgs/:slug/
 * invite`, `/v1/orgs/:slug/accept-invitation`, AND `/api/auth/
 * organization/invite-member` and `/.../accept-invitation` — so the
 * gate is exhaustive, not a duplicate of one route.
 *
 * The free-plan defaults (max_members=3) make the over-limit scenario
 * awkward to reproduce in tests, so each case drops the limit to
 * 2 via `UPDATE plan_limits SET max_members = 2 WHERE plan = 'free'`.
 *
 * Predicate semantics (mirror `checkPlanLimit`): `usage >= limit`
 * is the rejection trigger — a 2-member org on a max_members=2
 * plan is already at the limit, so the next invite/accept that
 * would push to 3 is blocked. The contract's "third invite/accept"
 * language lands here: with the owner counting as 1, the third
 * MEMBER (= second invite + accept after the owner) is the
 * "third" attempt that fails.
 */

interface SeededUsers {
	owner: { userId: string; sessionCookie: string; apiKey: string; email: string }
	alice: { userId: string; sessionCookie: string; apiKey: string; email: string }
	bob: { userId: string; sessionCookie: string; apiKey: string; email: string }
}

async function seedUsers(fx: OrgTestStack): Promise<SeededUsers> {
	const owner = await signUp(fx, "owner@example.com", "password-12345")
	const alice = await signUp(fx, "alice@example.com", "password-12345")
	const bob = await signUp(fx, "bob@example.com", "password-12345")
	const ownerKey = await createApiKey(fx, owner.sessionCookie, { name: "owner-key" })
	const aliceKey = await createApiKey(fx, alice.sessionCookie, { name: "alice-key" })
	const bobKey = await createApiKey(fx, bob.sessionCookie, { name: "bob-key" })
	return {
		owner: { ...owner, apiKey: ownerKey.key, email: "owner@example.com" },
		alice: { ...alice, apiKey: aliceKey.key, email: "alice@example.com" },
		bob: { ...bob, apiKey: bobKey.key, email: "bob@example.com" },
	}
}

async function createOrg(fx: OrgTestStack, apiKey: string, name: string, slug: string): Promise<Response> {
	return authedFetch(fx, "/v1/orgs", { method: "POST", apiKey, body: { name, slug } })
}

async function invite(
	fx: OrgTestStack,
	apiKey: string,
	slug: string,
	email: string,
	role: "admin" | "member",
): Promise<Response> {
	return authedFetch(fx, `/v1/orgs/${slug}/invite`, { method: "POST", apiKey, body: { email, role } })
}

async function accept(fx: OrgTestStack, apiKey: string, slug: string, invitationId: string): Promise<Response> {
	return authedFetch(fx, `/v1/orgs/${slug}/accept-invitation`, {
		method: "POST",
		apiKey,
		body: { invitationId },
	})
}

async function memberCount(fx: OrgTestStack, slug: string): Promise<number> {
	const result = await fx.pglite.query<{ count: string }>(
		`SELECT COUNT(*)::text AS count
		   FROM "member" m
		   JOIN "organization" o ON o.id = m."organizationId"
		  WHERE o.slug = $1`,
		[slug],
	)
	return Number.parseInt(result.rows[0]?.count ?? "0", 10)
}

describe("VAL-SELF-006 step 3 — max_members is enforced on the invite + accept flow", () => {
	let fx: OrgTestStack
	beforeEach(async () => {
		fx = await buildOrgTestStack()
		// Lower the free-plan max_members to 2 so the over-limit case is
		// reproducible in a single test (the migration's default 3 would
		// need 3 invites).
		await fx.pglite.query(`UPDATE plan_limits SET max_members = 2 WHERE plan = 'free'`)
	})
	afterEach(async () => {
		await fx.close()
	})

	it("a 3rd invite against a 2-member free plan returns 403 naming the limit AND the plan", async () => {
		const seeded = await seedUsers(fx)
		const created = await createOrg(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)

		// Acme is now 1 member (owner). Bring it to the 2-member limit
		// by inviting + accepting alice (usage goes 1 → 2).
		const aliceInvite = await invite(fx, seeded.owner.apiKey, "acme", seeded.alice.email, "member")
		expect(aliceInvite.status).toBe(200)
		const aliceInviteBody = (await aliceInvite.json()) as { id: string }
		const aliceAccept = await accept(fx, seeded.alice.apiKey, "acme", aliceInviteBody.id)
		expect(aliceAccept.status).toBe(200)
		expect(await memberCount(fx, "acme")).toBe(2)

		// The next invite (which would push members past the limit)
		// must be blocked. The body shape mirrors the publish route's
		// plan-limit rejection so callers can branch on the same keys
		// (`error`, `limit`, `plan`, `usage`, `limitValue`).
		const bobInvite = await invite(fx, seeded.owner.apiKey, "acme", seeded.bob.email, "member")
		expect(bobInvite.status).toBe(403)
		expect(bobInvite.headers.get("content-type")).toMatch(/application\/json/)
		const body = (await bobInvite.json()) as {
			error?: string
			limit?: string
			plan?: string
			usage?: number
			limitValue?: number
		}
		expect(body.error?.toLowerCase()).toContain("max_members")
		expect(body.error?.toLowerCase()).toContain("free")
		expect(body.limit).toBe("max_members")
		expect(body.plan).toBe("free")
		expect(body.usage).toBe(2)
		expect(body.limitValue).toBe(2)

		// Membership did not increase — the failed invite did not
		// silently leak a row.
		expect(await memberCount(fx, "acme")).toBe(2)
	})

	it("an invitation issued under-limit cannot be accepted once the org reaches the limit (accept-path gate)", async () => {
		const seeded = await seedUsers(fx)
		const created = await createOrg(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)

		// Issue BOTH pending invitations BEFORE the org is at the
		// limit. usage = 1 (just the owner), limit = 2 — both invites
		// pass the invite gate cleanly.
		const aliceInvite = await invite(fx, seeded.owner.apiKey, "acme", seeded.alice.email, "member")
		expect(aliceInvite.status).toBe(200)
		const aliceInviteBody = (await aliceInvite.json()) as { id: string }

		const bobInvite = await invite(fx, seeded.owner.apiKey, "acme", seeded.bob.email, "member")
		expect(bobInvite.status).toBe(200)
		const bobInviteBody = (await bobInvite.json()) as { id: string }

		// Alice accepts first — the org reaches the limit (2/2).
		const aliceAccept = await accept(fx, seeded.alice.apiKey, "acme", aliceInviteBody.id)
		expect(aliceAccept.status).toBe(200)
		expect(await memberCount(fx, "acme")).toBe(2)

		// Bob's invite is still pending, but Bob tries to accept
		// now. The accept-path gate fires: usage = 2, limit = 2 → 403.
		// This is exactly the user-testing scenario: alice's accept
		// pushed to 2, so the next accept must fail honestly with a
		// 403 naming the limit and the plan.
		const bobAccept = await accept(fx, seeded.bob.apiKey, "acme", bobInviteBody.id)
		expect(bobAccept.status).toBe(403)
		const body = (await bobAccept.json()) as {
			error?: string
			limit?: string
			plan?: string
			usage?: number
			limitValue?: number
		}
		expect(body.error?.toLowerCase()).toContain("max_members")
		expect(body.error?.toLowerCase()).toContain("free")
		expect(body.limit).toBe("max_members")
		expect(body.plan).toBe("free")
		expect(body.usage).toBe(2)
		expect(body.limitValue).toBe(2)

		// Membership did not increase; bob's pending invite remains
		// (the hook fires before the row insert — bob's membership
		// insert is rolled back, the invite row is unchanged).
		expect(await memberCount(fx, "acme")).toBe(2)
	})

	it("under-limit invite + accept succeed (control case — pins the symmetric 'at-limit and under-limit invites still work' contract)", async () => {
		const seeded = await seedUsers(fx)
		const created = await createOrg(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)

		// usage = 1 (owner), limit = 2. The first invite + accept
		// brings members to 2, exactly at the limit, and the gate
		// correctly does NOT fire (usage < limit is the accept
		// predicate); the org is now AT the limit but no OVER the
		// limit — "at-limit and under-limit invites still work".
		const aliceInvite = await invite(fx, seeded.owner.apiKey, "acme", seeded.alice.email, "member")
		expect(aliceInvite.status).toBe(200)
		const aliceInviteBody = (await aliceInvite.json()) as { id: string }
		const aliceAccept = await accept(fx, seeded.alice.apiKey, "acme", aliceInviteBody.id)
		expect(aliceAccept.status).toBe(200)
		expect(await memberCount(fx, "acme")).toBe(2)
	})

	it("under-limit invite + accept work with default plan_limits (free / max_members=3), proving the gate is calibrated to the plan", async () => {
		// Reset plan_limits so this case exercises the migration's
		// default (free / max_members=3) — proving the gate reads
		// plan_limits dynamically and does not hard-code 2.
		await fx.pglite.query(`UPDATE plan_limits SET max_members = 3 WHERE plan = 'free'`)
		const seeded = await seedUsers(fx)
		const created = await createOrg(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)

		// With limit=3 and starting at 1 (owner), all three invites
		// + accepts land members at 4 distinct rows. The first three
		// are within the limit; the fourth attempt would push to 4
		// (= limit+1) and is blocked.
		// Setup needs THREE extra users, but the seed-helper defines
		// three already (owner + alice + bob). Register a third user
		// 'carol' on the fly.
		const carol = await signUp(fx, "carol@example.com", "password-12345")
		const carolKey = await createApiKey(fx, carol.sessionCookie, { name: "carol-key" })

		// Step 1 (alice): usage 1 → 2. Pass (under-limit).
		const aliceInvite = await invite(fx, seeded.owner.apiKey, "acme", seeded.alice.email, "member")
		expect(aliceInvite.status).toBe(200)
		const aliceBody = (await aliceInvite.json()) as { id: string }
		const aliceAccept = await accept(fx, seeded.alice.apiKey, "acme", aliceBody.id)
		expect(aliceAccept.status).toBe(200)

		// Step 2 (bob): usage 2 → 3. Pass (under-limit, lands AT limit).
		const bobInvite = await invite(fx, seeded.owner.apiKey, "acme", seeded.bob.email, "member")
		expect(bobInvite.status).toBe(200)
		const bobBody = (await bobInvite.json()) as { id: string }
		const bobAccept = await accept(fx, seeded.bob.apiKey, "acme", bobBody.id)
		expect(bobAccept.status).toBe(200)

		// Step 3 (carol): usage 3 → 4. Blocked (over-limit).
		const carolInvite = await invite(fx, seeded.owner.apiKey, "acme", "carol@example.com", "member")
		expect(carolInvite.status).toBe(403)
		const carolBody = (await carolInvite.json()) as { plan?: string; limitValue?: number }
		expect(carolBody.plan).toBe("free")
		expect(carolBody.limitValue).toBe(3)
		expect(await memberCount(fx, "acme")).toBe(3)
		void carolKey
	})
})
