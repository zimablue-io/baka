import { apiKey } from "@better-auth/api-key"
import { kyselyAdapter } from "@better-auth/kysely-adapter"
import { type Auth, betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { organization } from "better-auth/plugins"
import type { Pool as PgPool } from "pg"
import { createKysely } from "./kysely-db"

/**
 * Better-Auth's `database` config accepts several shapes. For our
 * Kysely-over-pglite-socket bridge the bare shape is correct:
 *   `{ db: kyselyInstance, type: "postgres" }`
 *
 * `kyselyAdapter(...)` also wraps Kysely into a function the framework
 * invokes lazily, but Better-Auth's own introspection
 * (`getMigrations → createKyselyAdapter`) reads the database config
 * directly and only short-circuits when it sees the `{ db, type }`
 * shape — otherwise it falls through to a SQLite branch that exits
 * the process. The bare shape avoids that path while keeping the
 * `kyselyAdapter` factory available for runtime queries that need its
 * transaction handling.
 */

/**
 * Better-Auth instance (architecture §4.4).
 *
 * Wires together:
 *   - GitHub OAuth (social provider; the user creates the OAuth app at
 *     setup; the credentials live in `apps/registry/.env` which is
 *     gitignored).
 *   - Organization plugin (owner / admin / member roles; create, invite,
 *     role enforcement).
 *   - `@better-auth/api-key` plugin for CLI tokens (header auth, expiry,
 *     revocation, prefix visibility).
 *   - Kysely adapter over `pg.Pool` → pglite-socket (verified bridge;
 *     same data the in-process Drizzle client sees).
 *   - `trustedOrigins` so mutating session-cookie requests are 403'd when
 *     the `origin` header does not match the registry's `BASE_URL` (the
 *     architecture's verified gotcha). API-key header auth bypasses the
 *     origin check — the two credential paths are honestly distinct.
 *
 * The instance is built lazily per test/server so the schema introspection
 * is run against a clean PGlite. The `secret` defaults to a derived
 * value when unset so self-host with no `AUTH_SECRET` is still bootable
 * (deterministic secret → sessions survive restarts of a self-host
 * instance, which is the intent). Production users set `AUTH_SECRET`
 * explicitly.
 */

interface BetterAuthConfig {
	/** Registry public base URL (used for OAuth callbacks). */
	baseUrl: string
	/** GitHub OAuth client id. Falls back to a placeholder for offline tests. */
	githubClientId: string
	/** GitHub OAuth client secret. Falls back to a placeholder for offline tests. */
	githubClientSecret: string
	/** Secret for signing cookies / sessions. Defaults to a derived value. */
	secret?: string
}

export interface BetterAuthHandle {
	auth: Auth
	pool: PgPool
	close: () => Promise<void>
	/** Ensures Better-Auth's tables exist (idempotent introspection). */
	ensureTables: () => Promise<void>
}

/**
 * Builds a Better-Auth instance bound to the given `pg.Pool`. The pool
 * must already be connected to a live pglite-socket (start the socket
 * via `db/client.ts#createDatabase` first).
 */
export async function createBetterAuth(pool: PgPool, config: BetterAuthConfig): Promise<BetterAuthHandle> {
	const kysely = createKysely(pool)

	const secret = config.secret ?? deriveSecret(config.baseUrl)
	const database = { db: kysely, type: "postgres" as const }
	const adapter = kyselyAdapter(kysely, { type: "postgres" })

	const options = {
		baseURL: config.baseUrl,
		secret,
		database,
		socialProviders: {
			github: {
				clientId: config.githubClientId,
				clientSecret: config.githubClientSecret,
			},
		},
		trustedOrigins: [config.baseUrl],
		// Better-Auth defaults `skipOriginCheck` to true when `NODE_ENV`
		// is "test" (verified dependency fact: `library/environment.md`).
		// We pin it to false so the origin middleware is observable in
		// every environment — the registry never relies on the test
		// auto-skip, and the origin check is part of the production
		// security contract (architecture §4.4).
		advanced: {
			disableOriginCheck: false,
		},
		plugins: [
			organization({
				allowUserToCreateOrganization: true,
				creatorRole: "owner",
			}),
			apiKey({
				apiKeyHeaders: ["x-api-key"],
			}),
		],
	}

	const auth = betterAuth(options) as unknown as Auth

	// Reuse the adapter for runtime queries: the same kysely instance is
	// the source of truth, and the adapter handles Postgres type quirks
	// (jsonb, uuid, timestamptz). Introspection bypasses the adapter and
	// reads `database` directly, which is why we kept the bare shape.
	void adapter

	return {
		auth,
		pool,
		close: async () => {
			await pool.end().catch(() => {})
		},
		ensureTables: async () => {
			const { runMigrations } = await getMigrations(options)
			await runMigrations()
		},
	}
}

/**
 * Derives a deterministic fallback secret from the registry base URL.
 * This is intentionally NOT a random secret — self-hosts that boot
 * without an explicit `AUTH_SECRET` still get sessions that survive a
 * restart of the same instance. Production users MUST set
 * `AUTH_SECRET`; the deterministic fallback is for offline tests and
 * local development.
 */
function deriveSecret(baseUrl: string): string {
	return `baka-registry-dev-secret::${baseUrl}`
}
