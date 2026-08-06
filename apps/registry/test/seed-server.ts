/**
 * Seed server for user-testing validation (registry-core round 2).
 *
 * Boots a real PGlite + Better-Auth + Hono stack (email/password
 * enabled via buildOrgTestStack), seeds four users (owner/admin/member/
 * outsider), the `acme` org with admin+member invitations accepted, and
 * API keys for all four identities. Serves the app on a real HTTP port
 * via @hono/node-server so flow validators can test through curl
 * (black-box, per the validation contract's Tool: curl requirement).
 *
 * Writes credentials to the path in SEED_CREDS_FILE (default
 * /tmp/baka-seed-creds-round2.json) and stays up until killed.
 *
 * Usage:
 *   npx tsx apps/registry/test/seed-server.ts
 *   HTTP_PORT=4310 npx tsx apps/registry/test/seed-server.ts
 */

import { writeFileSync } from "node:fs"
import { serve } from "@hono/node-server"
import { buildOrgTestStack, createApiKey, type OrgTestStack, signUp } from "./auth-orgs-fixture"

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 4310)
const CREDS_FILE = process.env.SEED_CREDS_FILE ?? "/tmp/baka-seed-creds-round2.json"

interface SeededUser {
	userId: string
	sessionCookie: string
	apiKey: string
	apiKeyId: string
}

async function seed(fx: OrgTestStack): Promise<{
	keys: Record<string, SeededUser>
	emails: Record<string, string>
}> {
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

	// Create acme org as owner.
	const createRes = await fx.app.request("/v1/orgs", {
		method: "POST",
		headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": ownerKey.key },
		body: JSON.stringify({ name: "Acme", slug: "acme" }),
	})
	if (createRes.status !== 200) {
		throw new Error(`org create failed: ${createRes.status} ${await createRes.text()}`)
	}

	// Invite admin + member, then accept as the invited user.
	const roleKeys: Record<string, { key: string }> = {
		admin: { key: adminKey.key },
		member: { key: memberKey.key },
	}
	for (const role of ["admin", "member"] as const) {
		const inviteRes = await fx.app.request(`/v1/orgs/acme/invite`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": ownerKey.key },
			body: JSON.stringify({ email: emails[role], role }),
		})
		if (inviteRes.status !== 200) {
			throw new Error(`invite ${role} failed: ${inviteRes.status} ${await inviteRes.text()}`)
		}
		const inviteBody = (await inviteRes.json()) as { id: string }
		const acceptRes = await fx.app.request(`/v1/orgs/acme/accept-invitation`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: fx.baseUrl, "x-api-key": roleKeys[role].key },
			body: JSON.stringify({ invitationId: inviteBody.id }),
		})
		if (acceptRes.status !== 200) {
			throw new Error(`accept ${role} failed: ${acceptRes.status} ${await acceptRes.text()}`)
		}
	}

	return {
		keys: {
			owner: { ...owner, apiKey: ownerKey.key, apiKeyId: ownerKey.id },
			admin: { ...admin, apiKey: adminKey.key, apiKeyId: adminKey.id },
			member: { ...member, apiKey: memberKey.key, apiKeyId: memberKey.id },
			outsider: { ...outsider, apiKey: outsiderKey.key, apiKeyId: outsiderKey.id },
		},
		emails,
	}
}

async function main(): Promise<void> {
	const fx = await buildOrgTestStack()
	const seeded = await seed(fx)

	const creds = {
		httpPort: HTTP_PORT,
		baseUrl: fx.baseUrl,
		keys: {
			owner: seeded.keys.owner.apiKey,
			admin: seeded.keys.admin.apiKey,
			member: seeded.keys.member.apiKey,
			outsider: seeded.keys.outsider.apiKey,
		},
		keyIds: {
			owner: seeded.keys.owner.apiKeyId,
			admin: seeded.keys.admin.apiKeyId,
			member: seeded.keys.member.apiKeyId,
			outsider: seeded.keys.outsider.apiKeyId,
		},
		cookies: {
			owner: seeded.keys.owner.sessionCookie,
			admin: seeded.keys.admin.sessionCookie,
			member: seeded.keys.member.sessionCookie,
			outsider: seeded.keys.outsider.sessionCookie,
		},
		userIds: {
			owner: seeded.keys.owner.userId,
			admin: seeded.keys.admin.userId,
			member: seeded.keys.member.userId,
			outsider: seeded.keys.outsider.userId,
		},
		emails: seeded.emails,
	}
	writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2))

	serve({ fetch: fx.app.fetch, port: HTTP_PORT, hostname: "127.0.0.1" }, (info) => {
		process.stdout.write(`seed-server: listening on http://127.0.0.1:${info.port} (creds at ${CREDS_FILE})\n`)
	})

	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		process.stdout.write(`seed-server: received ${signal}, shutting down\n`)
		await fx.close()
		process.exit(0)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err)
	process.stderr.write(`seed-server: failed to start — ${message}\n`)
	process.exit(1)
})
