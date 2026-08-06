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
	/**
	 * Enables Better-Auth's email/password sign-up flow. Production
	 * keeps this OFF (architecture §4.4: GitHub OAuth only); the test
	 * fixture turns it on so users can be seeded without completing
	 * the GitHub OAuth dance.
	 */
	emailAndPassword?: {
		enabled: boolean
	}
	/**
	 * API-key rate limit overrides (Better-Auth's `apiKey` plugin).
	 *
	 * The plugin defaults to 10 requests per 24h per key, which trips
	 * concurrent validators and annoys self-hosters. These env-driven
	 * knobs let operators raise the ceiling or disable rate limiting
	 * entirely (e.g. `REGISTRY_API_KEY_RATE_LIMIT=off` for tests).
	 *
	 * Unset fields preserve the upstream default (`maxRequests: 10`,
	 * `timeWindow: 86_400_000` ms); `enabled: false` disables the
	 * check globally for the boot.
	 */
	apiKeyRateLimit?: {
		enabled?: boolean
		maxRequests?: number
		timeWindowMs?: number
	}
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
		// Disable Better-Auth's internal logger so request headers,
		// API keys, OAuth tokens, and other credential material are
		// never echoed to stdout/stderr (VAL-AUTH-014). Better-Auth
		// surfaces errors as structured APIError responses, so
		// silencing the logger does not change the HTTP contract.
		logger: { disabled: true },
		emailAndPassword: config.emailAndPassword ?? { enabled: false },
		plugins: [
			organization({
				allowUserToCreateOrganization: true,
				creatorRole: "owner",
			}),
			apiKey({
				apiKeyHeaders: ["x-api-key"],
				// Make `x-api-key` a valid credential for any route that
				// resolves a session — the plugin's before-hook turns
				// a valid key into a synthetic session. This is the
				// path the validation contract exercises via
				// /api/auth/get-session (VAL-AUTH-004). The plugin
				// enforces expiry / disabled / unknown-key rejection
				// itself; the Hono layer (handlers.ts) rewrites the
				// 403 the hook throws on malformed keys into a 401
				// so the contract's "401, not 500" surface holds.
				enableSessionForAPIKeys: true,
				// Operator-tunable rate limit (see apiKeyRateLimit on
				// BetterAuthConfig). Better-Auth omits fields it does
				// not receive, so passing an empty object restores the
				// upstream default — the env-parsing helper applies
				// the user's overrides only when the env var is set.
				rateLimit: buildApiKeyRateLimit(config.apiKeyRateLimit),
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
 * Translates the env-driven `apiKeyRateLimit` overrides into the
 * Better-Auth plugin's `rateLimit` shape. Returns `undefined` when no
 * overrides are set so the plugin falls back to its upstream defaults
 * (10 requests per 24h per key).
 *
 * Recognized env vars (all optional, parsed via `parseApiKeyRateLimitEnv`):
 *   - `REGISTRY_API_KEY_RATE_LIMIT=off`    → `enabled: false` (disable).
 *   - `REGISTRY_API_KEY_RATE_LIMIT_MAX`    → `maxRequests` (positive integer).
 *   - `REGISTRY_API_KEY_RATE_LIMIT_WINDOW_MS` → `timeWindow` (positive integer, ms).
 */
function buildApiKeyRateLimit(
	override: BetterAuthConfig["apiKeyRateLimit"],
): { enabled: boolean; maxRequests: number; timeWindow: number } | undefined {
	if (override === undefined) return undefined
	const out: { enabled?: boolean; maxRequests?: number; timeWindow?: number } = {}
	if (override.enabled === false) out.enabled = false
	if (typeof override.maxRequests === "number" && override.maxRequests > 0) {
		out.maxRequests = override.maxRequests
	}
	if (typeof override.timeWindowMs === "number" && override.timeWindowMs > 0) {
		out.timeWindow = override.timeWindowMs
	}
	// Nothing was set → defer to upstream defaults rather than
	// emitting an empty object Better-Auth would silently ignore.
	if (Object.keys(out).length === 0) return undefined
	return {
		enabled: out.enabled ?? true,
		maxRequests: out.maxRequests ?? 10,
		timeWindow: out.timeWindow ?? 86_400_000,
	}
}

/**
 * Parses the `REGISTRY_API_KEY_RATE_LIMIT*` env vars into the
 * `apiKeyRateLimit` shape `createBetterAuth` consumes.
 *
 * `REGISTRY_API_KEY_RATE_LIMIT=off` disables the check entirely;
 * any other value (or unset) leaves the default behavior in place.
 * `REGISTRY_API_KEY_RATE_LIMIT_MAX` and `_WINDOW_MS` raise the
 * ceiling without disabling. Malformed values fall through silently —
 * the documented contract is "default unchanged when unset".
 */
export function parseApiKeyRateLimitEnv(env: NodeJS.ProcessEnv = process.env): BetterAuthConfig["apiKeyRateLimit"] {
	const flag = env.REGISTRY_API_KEY_RATE_LIMIT?.trim().toLowerCase()
	const maxRaw = env.REGISTRY_API_KEY_RATE_LIMIT_MAX?.trim()
	const windowRaw = env.REGISTRY_API_KEY_RATE_LIMIT_WINDOW_MS?.trim()

	if (flag === undefined && maxRaw === undefined && windowRaw === undefined) {
		return undefined
	}

	const result: NonNullable<BetterAuthConfig["apiKeyRateLimit"]> = {}
	if (flag === "off" || flag === "0" || flag === "false" || flag === "disabled") {
		result.enabled = false
	}
	if (maxRaw !== undefined && maxRaw.length > 0) {
		const parsed = Number.parseInt(maxRaw, 10)
		if (Number.isFinite(parsed) && parsed > 0) {
			result.maxRequests = parsed
		}
	}
	if (windowRaw !== undefined && windowRaw.length > 0) {
		const parsed = Number.parseInt(windowRaw, 10)
		if (Number.isFinite(parsed) && parsed > 0) {
			result.timeWindowMs = parsed
		}
	}
	return result
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
