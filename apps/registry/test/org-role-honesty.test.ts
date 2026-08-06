import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { authedFetch, buildOrgTestStack, createApiKey, type OrgTestStack, signUp } from "./auth-orgs-fixture"

/**
 * Org-role-403-honesty feature (validation contract VAL-AUTH-008/015
 * honesty, registry-core user-testing round two).
 *
 * Pins four behaviors that the registry had drifted on:
 *
 *  1. Outsider mutations on an existing org must return 403 or 404
 *     (existence non-leakage) — never 401. The previous blanket
 *     401 envelope in `findOrgIdBySlug` collapsed both 401 and 403
 *     from Better-Auth's getFullOrganization lookup into a 401, which
 *     was wrong: a valid API key that proves authentication should
 *     never be told "authentication required" just because the caller
 *     is not a member of the named org. The fix differentiates:
 *       - 401 from Better-Auth's session middleware → 401 envelope
 *       - 403 from Better-Auth's membership check → 404 (existence
 *         is not leaked to authenticated non-members; matches the
 *         detail-endpoint convention).
 *
 *  2. Member mutations on owner-only actions (delete org, update
 *     member role on someone else) remain 403 — not 401 — because
 *     the caller IS authenticated and IS a member; the failure is a
 *     genuine permission decision, not an authentication gap.
 *
 *  3. PATCH /v1/orgs/:slug is the registry's organization-update
 *     route. It wraps Better-Auth's update endpoint, accepts the
 *     documented update body fields (name, slug, logo, metadata),
 *     and pre-validates the body — unknown fields like `plan` get a
 *     4xx JSON before reaching Better-Auth. Without the wrapper the
 *     Better-Auth path bubbles a Postgres syntax error (empty SET
 *     clause after field stripping) as a 500 with an empty body,
 *     which violates the uniform 4xx-error contract.
 *
 *  4. GET /v1/orgs items include `role` — the caller's role in that
 *     org. Better-Auth's org list does not carry the role per row
 *     (it's implicit in `findMemberByOrgId`); the registry enriches
 *     the response so a founder listing their org sees `role:
 *     "owner"` without needing a second members-endpoint round trip
 *     (VAL-AUTH-006).
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

/**
 * Asserts a status code is in the 403-or-404 set — the honest
 * enforcement surface for a non-member on an org-mutation route.
 * Distinct from `toBeGreaterThanOrEqual(400)` because that lower bound
 * includes 401, which is reserved for credential rejection (per
 * `isCredentialRejectionCode`).
 */
function expectForbiddenOrNotFound(res: Response): void {
	const status = res.status
	expect([403, 404]).toContain(status)
}

// ----------------------------------------------------------------------------
// Fix #1 — outsider mutations return 403 or 404, never 401
// ----------------------------------------------------------------------------

describe("outsider mutations return 403 or 404 (never 401)", () => {
	let fx: OrgTestStack
	let seeded: SeededUsers
	beforeEach(async () => {
		fx = await buildOrgTestStack()
		seeded = await seedFourUsers(fx)
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

	it("as OUTSIDER: inviting another user returns 403 or 404 (never 401)", async () => {
		const res = await inviteAs(fx, seeded.outsider.apiKey, "acme", "x@example.com", "member")
		expectForbiddenOrNotFound(res)
	})

	it("as OUTSIDER: changing a member's role returns 403 or 404 (never 401)", async () => {
		// Read member list as admin first to obtain a target memberId.
		const listRes = await authedFetch(fx, "/v1/orgs/acme/members", { apiKey: seeded.admin.apiKey })
		const listBody = (await listRes.json()) as { members: Array<{ id: string; role: string }> }
		const target = listBody.members.find((m) => m.role === "member")
		expect(target?.id).toBeDefined()

		const res = await authedFetch(fx, "/v1/orgs/acme/update-member-role", {
			method: "POST",
			apiKey: seeded.outsider.apiKey,
			body: { memberId: target?.id, role: "admin" },
		})
		expectForbiddenOrNotFound(res)
	})

	it("as OUTSIDER: deleting the org returns 403 or 404 (never 401)", async () => {
		const res = await deleteOrgAs(fx, seeded.outsider.apiKey, "acme")
		expectForbiddenOrNotFound(res)
	})

	it("as OUTSIDER: listing the org's members returns 403 or 404 (never 401)", async () => {
		const res = await authedFetch(fx, "/v1/orgs/acme/members", { apiKey: seeded.outsider.apiKey })
		expectForbiddenOrNotFound(res)
	})

	it("credential-rejection surface is unaffected: a malformed API key still returns 401 (not 403/404)", async () => {
		// Sanity pin: only membership 403s are translated; credential
		// failures keep their 401 envelope (the registry's two
		// credential paths are honestly distinct).
		const res = await authedFetch(fx, "/v1/orgs/acme/members", {
			apiKey: "not-a-real-key",
		})
		expect(res.status).toBe(401)
	})
})

// ----------------------------------------------------------------------------
// Fix #2 — PATCH /v1/orgs/:slug org-update
// ----------------------------------------------------------------------------

describe("PATCH /v1/orgs/:slug — org update", () => {
	let fx: OrgTestStack
	let seeded: SeededUsers
	beforeEach(async () => {
		fx = await buildOrgTestStack()
		seeded = await seedFourUsers(fx)
		const created = await createOrgAs(fx, seeded.owner.apiKey, "Acme", "acme")
		expect(created.status).toBe(200)
		// Seed admin + member so role-enforcement assertions have
		// distinct roles to compare against.
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

	it("as OWNER: PATCH with a valid `name` returns 200 with the updated org", async () => {
		const res = await authedFetch(fx, "/v1/orgs/acme", {
			method: "PATCH",
			apiKey: seeded.owner.apiKey,
			body: { data: { name: "Acme Renamed" } },
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { id: string; slug: string; name: string }
		expect(body.name).toBe("Acme Renamed")
		expect(body.slug).toBe("acme")
	})

	it("as ADMIN: PATCH with a valid `name` returns 200 with the updated org", async () => {
		const res = await authedFetch(fx, "/v1/orgs/acme", {
			method: "PATCH",
			apiKey: seeded.admin.apiKey,
			body: { data: { name: "Renamed By Admin" } },
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { name: string }
		expect(body.name).toBe("Renamed By Admin")
	})

	it("as MEMBER: PATCH is rejected with 403 (admin-only update role)", async () => {
		const res = await authedFetch(fx, "/v1/orgs/acme", {
			method: "PATCH",
			apiKey: seeded.member.apiKey,
			body: { data: { name: "Should Not Happen" } },
		})
		// Better-Auth's organization-update permission is admin+. A
		// regular member gets 403 (role enforcement), distinct from
		// outsider 403/404 (membership non-leak).
		expect(res.status).toBe(403)
	})

	it("as OUTSIDER: PATCH returns 403 or 404 (never 401)", async () => {
		const res = await authedFetch(fx, "/v1/orgs/acme", {
			method: "PATCH",
			apiKey: seeded.outsider.apiKey,
			body: { data: { name: "Should Not Happen" } },
		})
		expectForbiddenOrNotFound(res)
	})

	it("without authentication: PATCH returns 401 (auth required)", async () => {
		const res = await fx.app.request("/v1/orgs/acme", {
			method: "PATCH",
			headers: { "content-type": "application/json", origin: fx.baseUrl },
			body: JSON.stringify({ data: { name: "Anything" } }),
		})
		expect(res.status).toBe(401)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
	})

	it("PATCH with an unknown field like `plan` returns 4xx JSON (never 500)", async () => {
		// Better-Auth's body schema strips `plan`, then the Kysely
		// adapter issues an UPDATE ... SET with no columns (Postgres
		// returns syntax error code 42601) — leaking as a 500 with an
		// empty body. The registry pre-validates the known-field set
		// and surfaces the rejection as a 4xx with an honest JSON
		// body naming the field.
		const res = await authedFetch(fx, "/v1/orgs/acme", {
			method: "PATCH",
			apiKey: seeded.owner.apiKey,
			body: { data: { name: "Acme", plan: "pro" } },
		})
		expect(res.status).toBeGreaterThanOrEqual(400)
		expect(res.status).toBeLessThan(500)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
		const body = (await res.json()) as { error?: string }
		expect(typeof body.error).toBe("string")
		expect(body.error?.toLowerCase()).toContain("plan")
	})

	it("PATCH with a top-level unknown field (no `data` wrapper) returns 4xx JSON, never 500", async () => {
		// Better-Auth requires `data` in the body schema; an unknown
		// top-level field triggers a 400 VALIDATION_ERROR. Either way
		// the registry must catch the 4xx cleanly and return JSON.
		const res = await authedFetch(fx, "/v1/orgs/acme", {
			method: "PATCH",
			apiKey: seeded.owner.apiKey,
			body: { plan: "pro" },
		})
		expect(res.status).toBeGreaterThanOrEqual(400)
		expect(res.status).toBeLessThan(500)
		expect(res.headers.get("content-type")).toMatch(/application\/json/)
	})

	it("PATCH never lets the org plan become `pro` even on the rejected path (VAL-AUTH-017 contract)", async () => {
		const before = await fx.pglite.query<{ plan: string }>(`SELECT plan FROM "organization" WHERE "slug" = 'acme'`)
		expect(before.rows[0]?.plan).toBe("free")

		const res = await authedFetch(fx, "/v1/orgs/acme", {
			method: "PATCH",
			apiKey: seeded.owner.apiKey,
			body: { data: { plan: "pro" } },
		})
		expect(res.status).toBeGreaterThanOrEqual(400)

		const after = await fx.pglite.query<{ plan: string }>(`SELECT plan FROM "organization" WHERE "slug" = 'acme'`)
		expect(after.rows[0]?.plan).toBe("free")
	})
})

// ----------------------------------------------------------------------------
// Fix #4 — GET /v1/orgs items include the caller's role
// ----------------------------------------------------------------------------

describe("GET /v1/orgs items include caller's role", () => {
	let fx: OrgTestStack
	let seeded: SeededUsers
	beforeEach(async () => {
		fx = await buildOrgTestStack()
		seeded = await seedFourUsers(fx)
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

	it("the founder's GET /v1/orgs includes role `owner` on the listed org", async () => {
		const res = await authedFetch(fx, "/v1/orgs", { apiKey: seeded.owner.apiKey })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ slug: string; role: string }>
		expect(body).toHaveLength(1)
		expect(body[0]?.slug).toBe("acme")
		expect(body[0]?.role).toBe("owner")
	})

	it("the admin's GET /v1/orgs includes role `admin` on the listed org", async () => {
		const res = await authedFetch(fx, "/v1/orgs", { apiKey: seeded.admin.apiKey })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ slug: string; role: string }>
		expect(body).toHaveLength(1)
		expect(body[0]?.slug).toBe("acme")
		expect(body[0]?.role).toBe("admin")
	})

	it("the member's GET /v1/orgs includes role `member` on the listed org", async () => {
		const res = await authedFetch(fx, "/v1/orgs", { apiKey: seeded.member.apiKey })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ slug: string; role: string }>
		expect(body).toHaveLength(1)
		expect(body[0]?.slug).toBe("acme")
		expect(body[0]?.role).toBe("member")
	})

	it("the outsider's GET /v1/orgs is still an empty list (role never leaks)", async () => {
		const res = await authedFetch(fx, "/v1/orgs", { apiKey: seeded.outsider.apiKey })
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown[]
		expect(body).toEqual([])
	})
})
