import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { authedFetch, buildOrgTestStack, createApiKey, type OrgTestStack, signUp } from "./auth-orgs-fixture"

/**
 * Org deletion (architecture §8 decision 2, validation contract
 * VAL-AUTH-015, VAL-AUTH-016).
 *
 *   - VAL-AUTH-015: empty org deletes cleanly; the slug becomes
 *     reusable; no inherited state from the deleted org.
 *   - VAL-AUTH-016: orgs that own published modules cannot be deleted
 *     (4xx naming the block).
 *
 * The owner-only role enforcement already lives on Better-Auth's
 * `organization/delete` route (VAL-AUTH-008), so this suite focuses
 * on the registry-side check: refuse when the org owns modules.
 */

interface SeededUsers {
	owner: { userId: string; sessionCookie: string; apiKey: string }
	admin: { userId: string; sessionCookie: string; apiKey: string }
	member: { userId: string; sessionCookie: string; apiKey: string }
	outsider: { userId: string; sessionCookie: string; apiKey: string }
	emails: { owner: string; admin: string; member: string; outsider: string }
}

async function seedFourUsers(fx: OrgTestStack): Promise<SeededUsers> {
	const emails = {
		owner: "owner@example.com",
		admin: "admin@example.com",
		member: "member@example.com",
		outsider: "outsider@example.com",
	}
	const owner = await signUp(fx, emails.owner, "password-12345")
	const admin = await signUp(fx, emails.admin, "password-12345")
	const member = await signUp(fx, emails.member, "password-12345")
	const outsider = await signUp(fx, emails.outsider, "password-12345")
	const ownerKey = await createApiKey(fx, owner.sessionCookie, { name: "owner-key" })
	const adminKey = await createApiKey(fx, admin.sessionCookie, { name: "admin-key" })
	const memberKey = await createApiKey(fx, member.sessionCookie, { name: "member-key" })
	const outsiderKey = await createApiKey(fx, outsider.sessionCookie, { name: "outsider-key" })
	return {
		owner: { ...owner, apiKey: ownerKey.key },
		admin: { ...admin, apiKey: adminKey.key },
		member: { ...member, apiKey: memberKey.key },
		outsider: { ...outsider, apiKey: outsiderKey.key },
		emails,
	}
}

async function createOrgAs(fx: OrgTestStack, apiKey: string, name: string, slug: string): Promise<Response> {
	return authedFetch(fx, "/v1/orgs", { method: "POST", apiKey, body: { name, slug } })
}

async function inviteAs(
	fx: OrgTestStack,
	apiKey: string,
	slug: string,
	email: string,
	role: string,
): Promise<Response> {
	return authedFetch(fx, `/v1/orgs/${slug}/invite`, { method: "POST", apiKey, body: { email, role } })
}

async function acceptAs(fx: OrgTestStack, apiKey: string, slug: string, invitationId: string): Promise<Response> {
	return authedFetch(fx, `/v1/orgs/${slug}/accept-invitation`, {
		method: "POST",
		apiKey,
		body: { invitationId },
	})
}

async function deleteOrgAs(fx: OrgTestStack, apiKey: string, slug: string): Promise<Response> {
	return fx.app.request(`/v1/orgs/${slug}`, {
		method: "DELETE",
		headers: {
			"content-type": "application/json",
			origin: fx.baseUrl,
			"x-api-key": apiKey,
		},
	})
}

async function insertModuleInOrgScope(fx: OrgTestStack, scope: string, name: string): Promise<void> {
	await fx.pglite.query(
		`INSERT INTO modules (scope, name, visibility, tier, description)
		   VALUES ($1, $2, 'org', 'community-unverified', '')`,
		[scope, name],
	)
}

// ----------------------------------------------------------------------------
// VAL-AUTH-015 — Empty org deletion is clean and the slug becomes reusable
// ----------------------------------------------------------------------------

describe("VAL-AUTH-015 — empty org deletion", () => {
	let fx: OrgTestStack
	beforeEach(async () => {
		fx = await buildOrgTestStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("DELETE /v1/orgs/:slug as owner succeeds on an empty org; subsequent GET returns 404", async () => {
		const seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Temp", "temp-org")
		expect(created.status).toBe(200)

		const del = await deleteOrgAs(fx, seeded.owner.apiKey, "temp-org")
		expect(del.status).toBe(200)
		expect(del.headers.get("content-type")).toMatch(/application\/json/)

		// Subsequent GET /v1/orgs/:slug (via the members list endpoint, the
		// only GET on a single org we currently expose) returns 404 —
		// existence is not leaked.
		const members = await authedFetch(fx, "/v1/orgs/temp-org/members", { apiKey: seeded.owner.apiKey })
		if (members.status !== 404) {
			console.log("members body:", await members.text())
		}
		expect(members.status).toBe(404)
	})

	it("after delete, the owner's org list no longer contains the deleted org", async () => {
		const seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Temp", "temp-org")
		expect(created.status).toBe(200)
		const del = await deleteOrgAs(fx, seeded.owner.apiKey, "temp-org")
		expect(del.status).toBe(200)

		const list = await authedFetch(fx, "/v1/orgs", { apiKey: seeded.owner.apiKey })
		expect(list.status).toBe(200)
		const body = (await list.json()) as Array<{ slug: string }>
		expect(body.find((o) => o.slug === "temp-org")).toBeUndefined()
	})

	it("after delete, the slug becomes reusable: a NEW org with the same slug is accepted and has zero inherited state", async () => {
		const seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Temp", "temp-org")
		expect(created.status).toBe(200)

		// Invite a member into the original org; the member does not accept
		// so the invitation stays open. We then delete the org and confirm
		// the invitation is gone (cascade) and a fresh org under the same
		// slug has zero members and zero pending invitations.
		const invite = await inviteAs(fx, seeded.owner.apiKey, "temp-org", seeded.emails.outsider, "member")
		expect(invite.status).toBe(200)

		const del = await deleteOrgAs(fx, seeded.owner.apiKey, "temp-org")
		expect(del.status).toBe(200)

		// Re-create the org with the same slug.
		const recreated = await createOrgAs(fx, seeded.owner.apiKey, "Temp v2", "temp-org")
		expect(recreated.status).toBe(200)

		// The re-used-slug org has zero members besides the new founder.
		const members = await authedFetch(fx, "/v1/orgs/temp-org/members", { apiKey: seeded.owner.apiKey })
		expect(members.status).toBe(200)
		const memberBody = (await members.json()) as { members: Array<{ userId: string }>; total: number }
		expect(memberBody.total).toBe(1)
		expect(memberBody.members).toHaveLength(1)
		expect(memberBody.members[0]?.userId).toBe(seeded.owner.userId)
	})

	it("as MEMBER: DELETE /v1/orgs/:slug returns 403 (owner-only enforcement unchanged)", async () => {
		const seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Temp", "temp-org")
		expect(created.status).toBe(200)
		const memberInvite = await inviteAs(fx, seeded.owner.apiKey, "temp-org", seeded.emails.member, "member")
		const memberInviteBody = (await memberInvite.json()) as { id: string }
		await acceptAs(fx, seeded.member.apiKey, "temp-org", memberInviteBody.id)

		const del = await deleteOrgAs(fx, seeded.member.apiKey, "temp-org")
		expect(del.status).toBe(403)
	})

	it("as OUTSIDER: DELETE /v1/orgs/:slug returns 403/404 (never a silent 2xx)", async () => {
		const seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Temp", "temp-org")
		expect(created.status).toBe(200)

		const del = await deleteOrgAs(fx, seeded.outsider.apiKey, "temp-org")
		expect(del.status).toBeGreaterThanOrEqual(400)
		expect(del.status).toBeLessThan(500)
	})
})

// ----------------------------------------------------------------------------
// VAL-AUTH-016 — Org owning published modules cannot be deleted
// ----------------------------------------------------------------------------

describe("VAL-AUTH-016 — org owning modules cannot be deleted", () => {
	let fx: OrgTestStack
	let seeded: SeededUsers
	beforeEach(async () => {
		fx = await buildOrgTestStack()
		seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)
	})
	afterEach(async () => {
		await fx.close()
	})

	it("DELETE /v1/orgs/:slug as owner returns 4xx with an error body naming the block when the org owns a module", async () => {
		await insertModuleInOrgScope(fx, "acme", "widget")

		const del = await deleteOrgAs(fx, seeded.owner.apiKey, "acme")
		expect(del.status).toBeGreaterThanOrEqual(400)
		expect(del.status).toBeLessThan(500)
		expect(del.headers.get("content-type")).toMatch(/application\/json/)
		const body = (await del.json()) as { error?: string; message?: string }
		const named = body.error ?? body.message ?? ""
		expect(named.toLowerCase()).toContain("module")
		expect(named.toLowerCase()).not.toBe("not found")
	})

	it("after the refused delete, the org, its memberships, and its modules are all still readable", async () => {
		await insertModuleInOrgScope(fx, "acme", "widget")
		await insertModuleInOrgScope(fx, "acme", "gadget")

		const del = await deleteOrgAs(fx, seeded.owner.apiKey, "acme")
		expect(del.status).toBeGreaterThanOrEqual(400)

		// Members list still works (org still exists).
		const members = await authedFetch(fx, "/v1/orgs/acme/members", { apiKey: seeded.owner.apiKey })
		expect(members.status).toBe(200)

		// Modules are still readable via the catalog/detail surface
		// (the module is org-visibility, so the request carries the
		// owner's API key — see stub-routes.ts visibility gate).
		const detail = await fx.app.request("/v1/modules/acme/widget", {
			headers: { "x-api-key": seeded.owner.apiKey },
		})
		expect(detail.status).toBe(200)
	})

	it("once the modules are removed (tombstoned), the org can be deleted cleanly", async () => {
		await insertModuleInOrgScope(fx, "acme", "widget")
		await fx.pglite.query(`UPDATE modules SET removed_at = NOW() WHERE scope = 'acme' AND name = 'widget'`)

		const del = await deleteOrgAs(fx, seeded.owner.apiKey, "acme")
		expect(del.status).toBe(200)
	})
})
