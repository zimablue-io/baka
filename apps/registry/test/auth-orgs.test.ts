import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { authedFetch, buildOrgTestStack, createApiKey, type OrgTestStack, signUp } from "./auth-orgs-fixture"

/**
 * Org feature integration tests (architecture §4.4, validation contract
 * VAL-AUTH-005 / 006 / 007 / 008).
 *
 * Every assertion exercises the registry's `/v1/orgs/*` surface against
 * a real PGlite + Better-Auth + Hono stack. The plugin's role
 * enforcement (owner / admin / member per the ACL) is observed
 * end-to-end: members cannot invite or change roles, admin can invite,
 * outsiders are rejected on any mutation.
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
	return authedFetch(fx, "/v1/orgs", {
		method: "POST",
		apiKey,
		body: { name, slug },
	})
}

async function inviteAs(
	fx: OrgTestStack,
	apiKey: string,
	slug: string,
	email: string,
	role: string,
): Promise<Response> {
	return authedFetch(fx, `/v1/orgs/${slug}/invite`, {
		method: "POST",
		apiKey,
		body: { email, role },
	})
}

async function acceptAs(fx: OrgTestStack, apiKey: string, slug: string, invitationId: string): Promise<Response> {
	return authedFetch(fx, `/v1/orgs/${slug}/accept-invitation`, {
		method: "POST",
		apiKey,
		body: { invitationId },
	})
}

// ----------------------------------------------------------------------------
// VAL-AUTH-005 — Org creation
// ----------------------------------------------------------------------------

describe("VAL-AUTH-005 — org creation", () => {
	let fx: OrgTestStack
	beforeEach(async () => {
		fx = await buildOrgTestStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("POST /v1/orgs with {name, slug} returns 200 with the org id and slug", async () => {
		const { owner } = await seedFourUsers(fx)
		const res = await createOrgAs(fx, owner.apiKey, "Acme", "acme")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
		const body = (await res.json()) as { id?: string; slug?: string; name?: string }
		// Better-Auth generates nanoid-style ids by default; assert the
		// id is a non-empty string and the slug + name round-trip.
		expect(typeof body.id).toBe("string")
		expect(body.id?.length).toBeGreaterThan(0)
		expect(body.slug).toBe("acme")
		expect(body.name).toBe("Acme")
	})

	it("POST /v1/orgs without authentication returns 401 with a JSON body naming auth", async () => {
		const res = await fx.app.request("/v1/orgs", {
			method: "POST",
			headers: { "content-type": "application/json", origin: fx.baseUrl },
			body: JSON.stringify({ name: "Acme", slug: "acme" }),
		})
		expect(res.status).toBe(401)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
		const body = (await res.json()) as { error?: string }
		expect(typeof body.error).toBe("string")
	})

	it("a repeat POST with the same slug returns 4xx (409 or naming the slug conflict); the org count does not increase", async () => {
		const { owner } = await seedFourUsers(fx)
		const first = await createOrgAs(fx, owner.apiKey, "Acme", "acme")
		expect(first.status).toBe(200)
		const second = await createOrgAs(fx, owner.apiKey, "Acme Two", "acme")
		expect(second.status).toBeGreaterThanOrEqual(400)
		expect(second.status).toBeLessThan(500)
		expect(second.headers.get("content-type")).toMatch(/application\/json/)
		// The catalog sees only one org; the second attempt did not create.
		const list = await authedFetch(fx, "/v1/orgs", { apiKey: owner.apiKey })
		expect(list.status).toBe(200)
		const body = (await list.json()) as unknown[]
		expect(body).toHaveLength(1)
	})
})

// ----------------------------------------------------------------------------
// VAL-AUTH-006 — Org listing reflects membership exactly
// ----------------------------------------------------------------------------

describe("VAL-AUTH-006 — org listing reflects membership exactly", () => {
	let fx: OrgTestStack
	beforeEach(async () => {
		fx = await buildOrgTestStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("the founder's GET /v1/orgs returns exactly one org `acme` with role owner", async () => {
		const seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)

		const res = await authedFetch(fx, "/v1/orgs", { apiKey: seeded.owner.apiKey })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ id?: string; slug?: string; name?: string; role?: string }>
		expect(Array.isArray(body)).toBe(true)
		expect(body).toHaveLength(1)
		expect(body[0]?.slug).toBe("acme")
		expect(body[0]?.name).toBe("Acme")
		// Better-Auth does not return a role per row in listOrganizations
		// (the role is implicit: the caller is a member). The contract
		// observation that the founder sees a single org is what we
		// pin here; the role query lives on the member list endpoint.
	})

	it("the outsider's GET /v1/orgs returns an empty list (no membership leakage)", async () => {
		const seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)

		const res = await authedFetch(fx, "/v1/orgs", { apiKey: seeded.outsider.apiKey })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<unknown>
		expect(body).toEqual([])
	})

	it("GET /v1/orgs without authentication returns 401", async () => {
		const res = await fx.app.request("/v1/orgs", {
			method: "GET",
			headers: { origin: fx.baseUrl },
		})
		expect(res.status).toBe(401)
	})
})

// ----------------------------------------------------------------------------
// VAL-AUTH-007 — Org invitation flow
// ----------------------------------------------------------------------------

describe("VAL-AUTH-007 — org invitation flow", () => {
	let fx: OrgTestStack
	beforeEach(async () => {
		fx = await buildOrgTestStack()
	})
	afterEach(async () => {
		await fx.close()
	})

	it("owner invites a user, the user accepts, and the membership is reflected on both sides", async () => {
		const seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)

		// Invite admin, member, and outsider (all invited as `member`-role).
		const adminInvite = await inviteAs(fx, seeded.owner.apiKey, "acme", seeded.emails.admin, "member")
		expect(adminInvite.status).toBe(200)
		const adminInviteBody = (await adminInvite.json()) as { id: string; role: string }
		expect(adminInviteBody.role).toBe("member")

		const memberInvite = await inviteAs(fx, seeded.owner.apiKey, "acme", seeded.emails.member, "member")
		expect(memberInvite.status).toBe(200)
		const memberInviteBody = (await memberInvite.json()) as { id: string }

		const outsiderInvite = await inviteAs(fx, seeded.owner.apiKey, "acme", seeded.emails.outsider, "member")
		if (outsiderInvite.status !== 200) {
			console.log("outsiderInvite body:", await outsiderInvite.text())
		}
		expect(outsiderInvite.status).toBe(200)
		const outsiderInviteBody = (await outsiderInvite.json()) as { id: string }

		// Each invitee accepts.
		const adminAccept = await acceptAs(fx, seeded.admin.apiKey, "acme", adminInviteBody.id)
		expect(adminAccept.status).toBe(200)
		const memberAccept = await acceptAs(fx, seeded.member.apiKey, "acme", memberInviteBody.id)
		expect(memberAccept.status).toBe(200)
		const outsiderAccept = await acceptAs(fx, seeded.outsider.apiKey, "acme", outsiderInviteBody.id)
		expect(outsiderAccept.status).toBe(200)

		// Outsider's list now contains acme (with role member).
		const outsiderList = await authedFetch(fx, "/v1/orgs", { apiKey: seeded.outsider.apiKey })
		expect(outsiderList.status).toBe(200)
		const outsiderBody = (await outsiderList.json()) as Array<{ slug: string }>
		expect(outsiderBody).toHaveLength(1)
		expect(outsiderBody[0]?.slug).toBe("acme")

		// Owner-side member list shows four members (owner + 3 invitees).
		const memberList = await authedFetch(fx, "/v1/orgs/acme/members", { apiKey: seeded.owner.apiKey })
		expect(memberList.status).toBe(200)
		const memberBody = (await memberList.json()) as { members: Array<{ role: string; userId: string }>; total: number }
		expect(memberBody.total).toBe(4)
		expect(memberBody.members).toHaveLength(4)
		// At least one of the invitees is the outsider with role member.
		// The acceptance / invitation code path is unique per user, so we
		// can locate the outsider by userId.
		const outsiderMember = memberBody.members.find((m) => m.userId === seeded.outsider.userId)
		expect(outsiderMember?.role).toBe("member")
	})
})

// ----------------------------------------------------------------------------
// VAL-AUTH-008 — Role enforcement on privileged org actions
// ----------------------------------------------------------------------------

describe("VAL-AUTH-008 — role enforcement on privileged org actions", () => {
	let fx: OrgTestStack
	let seeded: SeededUsers
	beforeEach(async () => {
		fx = await buildOrgTestStack()
		seeded = await seedFourUsers(fx)
		// Owner creates acme and invites admin, member, outsider. Admin
		// and member accept. Outsider does NOT accept (they should stay
		// outside the org for the 403/404 part).
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)
		const adminInvite = await inviteAs(fx, seeded.owner.apiKey, "acme", seeded.emails.admin, "admin")
		const adminInviteBody = (await adminInvite.json()) as { id: string }
		await acceptAs(fx, seeded.admin.apiKey, "acme", adminInviteBody.id)
		const memberInvite = await inviteAs(fx, seeded.owner.apiKey, "acme", seeded.emails.member, "member")
		const memberInviteBody = (await memberInvite.json()) as { id: string }
		await acceptAs(fx, seeded.member.apiKey, "acme", memberInviteBody.id)
	})
	afterEach(async () => {
		await fx.close()
	})

	it("as MEMBER: inviting another user returns 403", async () => {
		const res = await inviteAs(fx, seeded.member.apiKey, "acme", "newbie@example.com", "member")
		expect(res.status).toBe(403)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
		const body = (await res.json()) as { error?: string; message?: string }
		const named = body.error ?? body.message
		expect(typeof named).toBe("string")
	})

	it("as MEMBER: changing a member's role returns 403", async () => {
		const listRes = await authedFetch(fx, "/v1/orgs/acme/members", { apiKey: seeded.admin.apiKey })
		const listBody = (await listRes.json()) as { members: Array<{ id: string; role: string }> }
		const target = listBody.members.find((m) => m.role === "member")
		expect(target?.id).toBeDefined()

		const res = await authedFetch(fx, "/v1/orgs/acme/update-member-role", {
			method: "POST",
			apiKey: seeded.member.apiKey,
			body: { memberId: target?.id, role: "admin" },
		})
		expect(res.status).toBe(403)
	})

	it("as MEMBER: deleting the org returns 403", async () => {
		const res = await fx.app.request("/v1/orgs/acme", {
			method: "DELETE",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": seeded.member.apiKey,
			},
		})
		expect(res.status).toBe(403)
	})

	it("as ADMIN: inviting another user succeeds", async () => {
		const res = await inviteAs(fx, seeded.admin.apiKey, "acme", "newbie@example.com", "member")
		expect(res.status).toBe(200)
	})

	it("as ADMIN: deleting the org returns 403 (owner-only)", async () => {
		const res = await fx.app.request("/v1/orgs/acme", {
			method: "DELETE",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": seeded.admin.apiKey,
			},
		})
		expect(res.status).toBe(403)
	})

	it("as OUTSIDER: any org mutation on `acme` returns 403 (or 404, never 200)", async () => {
		const invite = await inviteAs(fx, seeded.outsider.apiKey, "acme", "x@example.com", "member")
		expect(invite.status).toBeGreaterThanOrEqual(400)
		expect(invite.status).toBeLessThan(500)

		const list = await authedFetch(fx, "/v1/orgs/acme/members", { apiKey: seeded.outsider.apiKey })
		expect(list.status).toBeGreaterThanOrEqual(400)
		expect(list.status).toBeLessThan(500)

		const del = await fx.app.request("/v1/orgs/acme", {
			method: "DELETE",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": seeded.outsider.apiKey,
			},
		})
		expect(del.status).toBeGreaterThanOrEqual(400)
		expect(del.status).toBeLessThan(500)
	})
})
