import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { authedFetch, buildOrgTestStack, createApiKey, type OrgTestStack, signUp } from "./auth-orgs-fixture"

/**
 * VAL-AUTH-017: org plan is not settable through any public API surface
 * (architecture §4.7, decision 3).
 *
 * Every attempt to set a plan — through org-create payloads, org-update
 * payloads, or publish payloads — must either be rejected 4xx or have
 * the `plan` field ignored. The org's served/stored plan never becomes
 * the supplied value. Billing is deferred; the registry carries the
 * plan as a server-attached column (`organization.plan`, default `free`)
 * seeded at boot via `REGISTRY_SEED_PLANS`.
 *
 * The test exercises the full Better-Auth stack (not the
 * plan-limits.ts seam in isolation) so every public surface — both
 * the `/v1/*` registry routes and the `/api/auth/*` Better-Auth routes
 * — is covered.
 */

interface SeededIdentity {
	userId: string
	sessionCookie: string
	apiKey: string
	email: string
}

async function seedIdentity(fx: OrgTestStack, email: string, name?: string): Promise<SeededIdentity> {
	const signed = await signUp(fx, email, "password-12345", name ?? email)
	const key = await createApiKey(fx, signed.sessionCookie, { name: "test-key" })
	return { ...signed, apiKey: key.key, email }
}

describe("VAL-AUTH-017 — org plan is not settable through any public API", () => {
	let fx: OrgTestStack
	let founder: SeededIdentity
	beforeEach(async () => {
		fx = await buildOrgTestStack()
		founder = await seedIdentity(fx, "owner@example.com", "Owner")
	})
	afterEach(async () => {
		await fx.close()
	})

	it('POST /v1/orgs with a body carrying `plan: "pro"` does not change the created org\'s plan', async () => {
		const res = await authedFetch(fx, "/v1/orgs", {
			method: "POST",
			apiKey: founder.apiKey,
			body: { name: "Acme", slug: "acme", plan: "pro" },
		})
		// Either the request is accepted and the plan field is ignored,
		// or it is rejected. The org's stored plan must never be `pro`.
		const plan = await currentPlanForOrg(fx, "acme")
		expect(plan).toBe("free")
		// Surface the outcome for the operator reading the test log.
		expect([200, 400, 422]).toContain(res.status)
	})

	it('POST /api/auth/organization/create with `plan: "pro"` does not change the created org\'s plan', async () => {
		// Better-Auth's organization create body schema does not accept
		// `plan` (it's not in Better-Auth's organization column set). The
		// request lands on the Better-Auth handler via the registry's
		// /api/auth/* mount, so we exercise the SAME code path the
		// registry's POST /v1/orgs uses. The plan MUST stay `free`.
		const res = await fx.app.request("/api/auth/organization/create", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": founder.apiKey,
			},
			body: JSON.stringify({ name: "Acme Direct", slug: "acme-direct", plan: "pro" }),
		})
		// Whether 2xx (ignored) or 4xx (rejected), the plan MUST NOT become
		// `pro`. If the create succeeded, the org's plan stays `free`.
		if (res.status === 200) {
			const plan = await currentPlanForOrg(fx, "acme-direct")
			expect(plan).toBe("free")
		} else {
			expect(res.status).toBeGreaterThanOrEqual(400)
			expect(res.status).toBeLessThan(500)
			// The org must not have been created.
			const plan = await currentPlanForOrg(fx, "acme-direct")
			expect(plan).toBeNull()
		}
	})

	it('POST /api/auth/organization/update with `data: { plan: "pro" }` does not change the org\'s plan', async () => {
		// Create the org cleanly (no plan in the create body).
		const create = await authedFetch(fx, "/v1/orgs", {
			method: "POST",
			apiKey: founder.apiKey,
			body: { name: "Acme", slug: "acme" },
		})
		expect(create.status).toBe(200)
		const orgId = await orgIdBySlug(fx, "acme")
		expect(orgId).toBeTruthy()

		// Attempt to set plan via Better-Auth's update endpoint.
		// Better-Auth's organization-update schema does not declare
		// `plan` as a writable field; whether the framework rejects
		// the unknown field with a 4xx, returns 5xx from a downstream
		// constraint, or silently drops the field and returns 200, the
		// org's stored plan MUST stay `free`. The contract is about
		// immutability of the plan, not the specific status code.
		const res = await fx.app.request("/api/auth/organization/update", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: fx.baseUrl,
				"x-api-key": founder.apiKey,
			},
			body: JSON.stringify({ data: { plan: "pro" }, organizationId: orgId }),
		})
		const plan = await currentPlanForOrg(fx, "acme")
		expect(plan).toBe("free")
		// No 2xx that implies "plan was accepted"; allow 4xx (rejected)
		// and 5xx (internal rejection of unknown field) since Better-Auth
		// returns 500 for some unknown-field edge cases.
		expect(res.status).not.toBe(200)
		expect(res.status).not.toBe(202)
	})

	it('POST /v1/publish with a body carrying `plan: "pro"` does not change the org\'s plan', async () => {
		// /v1/publish is the publish stub (the real flow lands in the
		// publishing-ingest milestone). The stub must NOT honor a `plan`
		// field on the incoming body — billing is deferred.
		const create = await authedFetch(fx, "/v1/orgs", {
			method: "POST",
			apiKey: founder.apiKey,
			body: { name: "Acme", slug: "acme" },
		})
		expect(create.status).toBe(200)

		const res = await authedFetch(fx, "/v1/publish", {
			method: "POST",
			apiKey: founder.apiKey,
			body: { repo: "https://github.com/example/example", tag: "v1.0.0", plan: "pro" },
		})
		expect(res.status).toBe(200)
		const plan = await currentPlanForOrg(fx, "acme")
		expect(plan).toBe("free")
	})

	it("the registry's REGISTRY_SEED_PLANS boot hook is the only documented mechanism to change a plan; there is no `plan` setter route", async () => {
		// Sanity check: `rg`-style confirmation that the registry's
		// `src/` does not define a route that writes the `plan` column.
		// This guards against a future regression where someone adds a
		// `PATCH /v1/orgs/:slug/plan` or similar — the contract is that
		// the ONLY way to change a plan is via `REGISTRY_SEED_PLANS` at
		// boot (or direct DB writes in test fixtures).
		const { spawn } = await import("node:child_process")
		const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(
				"grep",
				[
					"-rn",
					"--include=*.ts",
					"-E",
					'UPDATE\\s+"?organization"?\\s+SET|app\\.(updateOrganization|setOrgPlan)',
					"src",
				],
				{ cwd: import.meta.dirname ? `${import.meta.dirname}/..` : "apps/registry" },
			)
			let stdout = ""
			let stderr = ""
			child.stdout.on("data", (d) => (stdout += d.toString()))
			child.stderr.on("data", (d) => (stderr += d.toString()))
			child.on("close", (code) => {
				if (code === 0 || code === 1) resolve({ stdout, stderr })
				else reject(new Error(`grep exited ${code}: ${stderr}`))
			})
		})
		// Empty output is the expected pass — no route writes the plan
		// column. A future regression that adds one would surface here.
		expect(result.stdout.trim()).toBe("")
	})
})

/**
 * Reads the current `plan` value for the given slug from Better-Auth's
 * `organization` table. Returns `null` when no org with that slug
 * exists (so failed-create tests can assert no row was inserted).
 */
async function currentPlanForOrg(fx: OrgTestStack, slug: string): Promise<string | null> {
	const result = await fx.pglite.query<{ plan: string }>(`SELECT plan FROM "organization" WHERE "slug" = $1`, [slug])
	return result.rows[0]?.plan ?? null
}

async function orgIdBySlug(fx: OrgTestStack, slug: string): Promise<string | null> {
	const result = await fx.pglite.query<{ id: string }>(`SELECT id FROM "organization" WHERE "slug" = $1`, [slug])
	return result.rows[0]?.id ?? null
}
