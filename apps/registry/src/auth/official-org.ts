import { createHash } from "node:crypto"
import type { PGlite } from "@electric-sql/pglite"

/**
 * Official-org bootstrap (architecture §8 decisions 26 and 29).
 *
 * Every registry binary — self-hosted, single-node, hosted — needs a
 * canonical "official" scope so bare-name publishing/resolution has a
 * deterministic target and the invariant "bare names exist only under
 * the official org" (architecture §4.5) holds. The official org is
 * created at boot if absent, and the env-driven `REGISTRY_OFFICIAL_ORG`
 * names its slug (default `baka`).
 *
 * Publisher authority (decision 29) is opt-in via
 * `REGISTRY_OFFICIAL_PUBLISHERS`, a comma-separated list of identity
 * references. Each entry is either:
 *   - A raw Better-Auth API key (the same value returned by the
 *     apiKey plugin's `create` endpoint). The bootstrap hashes the
 *     value with the plugin's `defaultKeyHasher` (SHA-256 →
 *     base64url, no padding) and looks up the hash in the `apikey`
 *     table; a match grants the user `owner` role on the official org.
 *   - A GitHub user ID. At boot, the registry looks up an existing
 *     user with that GitHub `accountId` and grants owner role; if no
 *     such user exists yet, the entry is skipped.
 *
 * When `REGISTRY_OFFICIAL_PUBLISHERS` is unset or empty, no identities
 * are granted owner role and the official org has no members; the
 * publish route will then return honest 403s for any caller trying
 * to publish to the official scope.
 *
 * The entire bootstrap is idempotent — calling `ensureOfficialOrg`
 * twice against the same data dir produces the same persistent state,
 * and `created` reports whether the first call actually inserted the
 * org row so callers can log the result.
 *
 * The API-key verification uses a direct DB lookup (the same SHA-256
 * + base64url hash the plugin uses to store the key) rather than
 * `auth.api.verifyApiKey`. The latter is a server-only endpoint that
 * is callable but introduces a fragile coupling on the plugin's
 * response shape and the per-key rate-limit counter — neither of
 * which is appropriate at boot, where we run the verify exactly once
 * per environment-configured publisher and want zero side effects.
 */

interface OfficialOrgConfig {
	/** Slug of the official org (env: `REGISTRY_OFFICIAL_ORG`, default `baka`). */
	officialOrg: string
	/** Comma-separated list of identity references (default: none). */
	officialPublishers?: string
}

interface PublisherOutcome {
	/** The raw value from the env var (after trimming). */
	value: string
	/** Resolved identity kind — `api-key` when the value verified, `github-user-id` otherwise. */
	resolved: "api-key" | "github-user-id" | "unknown"
	/** True when the entry actually granted owner role on the official org. */
	granted: boolean
	/** Set when an error was encountered resolving the entry. */
	error?: string
}

interface OfficialOrgResult {
	/** True when this boot inserted the official org row; false on a no-op re-run. */
	created: boolean
	/** Number of publishers that were granted owner role on this boot. */
	publishersGranted: number
	/** Number of publishers whose identity resolution returned an error. */
	publishersFailed: number
	/** Per-entry resolution log (one entry per env-var value, ordered). */
	publishers: PublisherOutcome[]
}

/**
 * Ensures the official org exists and the listed publishers are
 * granted owner role on it. Idempotent — every operation is a
 * conditional insert or an `ON CONFLICT … UPDATE` UPSERT.
 *
 * The function does NOT throw on per-publisher failures. A bad API
 * key, a GitHub user ID that doesn't match any user, or a transient
 * verification error is logged into `publishers[*].error` and the
 * rest of the publisher list still runs. The function only throws
 * on a programmer error (e.g. the official org row is missing after
 * the insert attempt — a DB invariant violation).
 */
export async function ensureOfficialOrg(pglite: PGlite, config: OfficialOrgConfig): Promise<OfficialOrgResult> {
	const slug = config.officialOrg
	if (slug.length === 0) {
		throw new Error("ensureOfficialOrg: officialOrg slug must be non-empty")
	}

	// 1. Ensure the org row exists. We insert directly into
	//    Better-Auth's `organization` table because the framework's
	//    createOrganization endpoint requires a session cookie, and
	//    the official org is system-owned (no human user "created"
	//    it). The Better-Auth introspection happily coexists with
	//    rows it did not insert; the column shape is the same.
	const existing = await pglite.query<{ id: string }>(`SELECT id FROM "organization" WHERE slug = $1`, [slug])
	let created = false
	if (existing.rows.length === 0) {
		await pglite.query(
			`INSERT INTO "organization" (id, name, slug, plan, "createdAt")
			 VALUES (gen_random_uuid(), $1, $2, 'free', NOW())`,
			[slug, slug],
		)
		created = true
	}

	// 2. Resolve and grant owner role to each publisher.
	const rawPublishers = parsePublishers(config.officialPublishers)
	const outcomes: PublisherOutcome[] = []
	let granted = 0
	let failed = 0

	for (const value of rawPublishers) {
		const outcome = await resolveAndGrant(pglite, value, slug)
		outcomes.push(outcome)
		if (outcome.error) {
			failed++
		}
		if (outcome.granted) {
			granted++
		}
	}

	return { created, publishersGranted: granted, publishersFailed: failed, publishers: outcomes }
}

/**
 * Resolves a single publisher entry to a user and grants owner role
 * on the official org. The default intent is API key: the value is
 * hashed with the plugin's `defaultKeyHasher` and looked up directly
 * in the `apikey` table. A failed API-key match is never silently
 * treated as a GitHub user ID — that would let a typo in a key
 * masquerade as a username lookup. The fallback to GitHub user ID is
 * opt-in via the `github:` prefix documented in `parsePublisherIntent`.
 */
async function resolveAndGrant(pglite: PGlite, value: string, slug: string): Promise<PublisherOutcome> {
	const intent = parsePublisherIntent(value)
	try {
		if (intent.kind === "github-user-id") {
			const userId = await findUserByGitHubUserId(pglite, intent.value)
			if (userId === null) {
				return { value: intent.value, resolved: "github-user-id", granted: false }
			}
			await addOwnerMember(pglite, userId, slug)
			return { value: intent.value, resolved: "github-user-id", granted: true }
		}
		// API key path (default). Hash the raw key with the plugin's
		// default hasher (SHA-256 → base64url, no padding) and look
		// up the hash in the `apikey` table. A match is a live key
		// whose `referenceId` is the user ID we grant owner role to.
		const userId = await findUserByApiKey(pglite, intent.value)
		if (userId === null) {
			return {
				value: intent.value,
				resolved: "api-key",
				granted: false,
				error: "no apikey row matches the hashed value",
			}
		}
		await addOwnerMember(pglite, userId, slug)
		return { value: intent.value, resolved: "api-key", granted: true }
	} catch (err) {
		return {
			value: intent.value,
			resolved: intent.kind,
			granted: false,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * Looks up the userId (stored as `referenceId` in the apiKey
 * plugin's table) for an active API key. The hash is the same
 * `defaultKeyHasher` the plugin uses internally (SHA-256 of the
 * UTF-8 bytes, base64url-encoded without padding). Disabled keys
 * and expired keys are filtered out so a stale env var entry
 * cannot silently grant authority to a user whose key was
 * revoked.
 */
async function findUserByApiKey(pglite: PGlite, rawKey: string): Promise<string | null> {
	const hashed = hashApiKey(rawKey)
	const rows = await pglite.query<{ referenceId: string }>(
		`SELECT "referenceId"
		   FROM "apikey"
		  WHERE "key" = $1
		    AND "enabled" = TRUE
		    AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
		  LIMIT 1`,
		[hashed],
	)
	const referenceId = rows.rows[0]?.referenceId
	if (typeof referenceId !== "string" || referenceId.length === 0) return null
	return referenceId
}

/**
 * SHA-256 of UTF-8 bytes → base64url with no padding. Matches the
 * Better-Auth apiKey plugin's `defaultKeyHasher` byte-for-byte
 * (the plugin uses WebCrypto's `crypto.subtle.digest("SHA-256", …)`
 * via `getWebcryptoSubtle`, then base64-encodes the result with
 * URL-safe alphabet). Using Node's `crypto` here is fine because
 * SHA-256 is deterministic across implementations and the base64
 * alphabet is platform-neutral.
 */
function hashApiKey(rawKey: string): string {
	const hash = createHash("sha256").update(new TextEncoder().encode(rawKey)).digest()
	return hash.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/**
 * Looks up a user by their GitHub provider account ID.
 * Better-Auth stores the GitHub provider's numeric user ID in
 * `account.accountId` with `providerId = "github"`.
 * Returns `null` when no user has linked that GitHub account yet.
 */
async function findUserByGitHubUserId(pglite: PGlite, githubAccountId: string): Promise<string | null> {
	const result = await pglite.query<{ userId: string }>(
		`SELECT "userId"
		   FROM "account"
		  WHERE "providerId" = 'github'
		    AND "accountId" = $1
		  LIMIT 1`,
		[githubAccountId],
	)
	const userId = result.rows[0]?.userId
	if (typeof userId !== "string" || userId.length === 0) return null
	return userId
}

/**
 * Adds (or upgrades) a `member` row for `userId` on the org with
 * `slug`, setting `role = 'owner'`. Better-Auth's `member` table
 * has individual indexes on `userId` and `organizationId` but no
 * composite unique constraint, so a Postgres `ON CONFLICT`
 * against `(userId, organizationId)` is rejected. The two-step
 * `UPDATE … WHERE` then `INSERT … WHERE NOT EXISTS` pattern is
 * the documented workaround — it is idempotent (re-running with
 * the same (userId, orgId) leaves the row unchanged) and avoids
 * the race window that a plain INSERT-then-try-CATCH would have.
 *
 * Throws when the org row is missing after the caller's prior
 * `ensureOfficialOrg` insert — that would be a DB invariant
 * violation, not a runtime condition.
 */
async function addOwnerMember(pglite: PGlite, userId: string, slug: string): Promise<void> {
	const orgRow = await pglite.query<{ id: string }>(`SELECT id FROM "organization" WHERE slug = $1`, [slug])
	const orgId = orgRow.rows[0]?.id
	if (typeof orgId !== "string" || orgId.length === 0) {
		throw new Error(`addOwnerMember: organization '${slug}' not found`)
	}
	const updated = await pglite.query(
		`UPDATE "member"
		   SET role = 'owner'
		 WHERE "userId" = $1
		   AND "organizationId" = $2`,
		[userId, orgId],
	)
	if (updated.affectedRows !== undefined && updated.affectedRows > 0) return
	await pglite.query(
		`INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
		 SELECT gen_random_uuid(), $1, $2, 'owner', NOW()
		 WHERE NOT EXISTS (
		   SELECT 1 FROM "member"
		    WHERE "userId" = $1 AND "organizationId" = $2
		 )`,
		[userId, orgId],
	)
}

/**
 * Parses the `REGISTRY_OFFICIAL_PUBLISHERS` env var into a list of
 * trimmed, non-empty strings. Whitespace and empty entries are
 * dropped silently so an env var like `alice,bob,` is fine.
 */
function parsePublishers(raw: string | undefined): string[] {
	if (raw === undefined) return []
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

/**
 * Classifies a single publisher entry. Recognized forms:
 *   - `key:<value>` — force treats the entry as an API key.
 *   - `github:<value>` — force treats the entry as a GitHub user ID.
 *   - `<value>` — defaults to API key (the verify-or-skip path).
 *
 * The explicit prefixes exist for self-host operators who want to
 * list identifiers that could otherwise be ambiguous. They are not
 * required.
 */
function parsePublisherIntent(value: string): { kind: "api-key" | "github-user-id"; value: string } {
	const colon = value.indexOf(":")
	if (colon > 0) {
		const prefix = value.slice(0, colon).toLowerCase()
		const rest = value.slice(colon + 1)
		if (prefix === "github") return { kind: "github-user-id", value: rest }
		if (prefix === "key") return { kind: "api-key", value: rest }
	}
	return { kind: "api-key", value }
}
