import { apiKey } from "@better-auth/api-key"
import { kyselyAdapter } from "@better-auth/kysely-adapter"
import type { PGlite } from "@electric-sql/pglite"
import { APIError, type Auth, betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { organization } from "better-auth/plugins"
import type { Pool as PgPool } from "pg"
import { createKysely } from "./kysely-db"
import { checkPlanLimit } from "./plan-limits"

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
	/**
	 * Optional PGlite handle for plan-limit enforcement hooks
	 * (VAL-SELF-006 step 3). When supplied, the Better-Auth instance
	 * is configured with `organizationHooks.beforeCreateInvitation`
	 * and `beforeAcceptInvitation` callbacks that call
	 * `checkPlanLimit(... "max_members")` and throw a 403 APIError
	 * naming the limit and plan when the org is at/over the limit.
	 *
	 * When `undefined`, no hooks are installed and the org
	 * invite/accept flow has no plan-limit gate. The field is
	 * optional so existing test fixtures and offline-only paths
	 * (e.g. auth-only hermetic tests) keep working unchanged — the
	 * production bootstrap (`server.ts`) and any test fixture that
	 * needs the gate (`publish-endpoint-fixture.ts`,
	 * `seed-publishing-server.ts`, the plan-member-limit suite)
	 * MUST pass `pglite`.
	 */
	pglite?: PGlite
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
				// Plan-limit gate (VAL-SELF-006 step 3) — the
				// organization plugin's documented
				// `organizationHooks.beforeCreateInvitation` and
				// `beforeAcceptInvitation` hooks fire for every
				// create-invite and accept-invitation call, including
				// the routes `/v1/orgs/:slug/invite` and
				// `/v1/orgs/:slug/accept-invitation` proxy to via
				// `/api/auth/organization/{invite-member,accept-invitation}`.
				// Both hooks call the same `checkPlanLimit(...,
				// "max_members")` helper the publish route uses for
				// `max_private_packs`, and throw an APIError 403
				// with the publish-route-shaped body (`{error, limit,
				// plan, usage, limitValue}`) when usage >= limit.
				//
				// The gate is gated behind `config.pglite` so test
				// fixtures that don't pass it (e.g. auth-only hermetic
				// tests) keep their original behavior; production
				// (`server.ts`) and any feature test that exercises
				// the gate MUST pass `pglite` in the config.
				//
				// Better-Auth's built-in `membershipLimit` would fire
				// BEFORE the hook (default 100) — for plans whose
				// max_members is well under 100, the built-in is
				// harmless. Setting it to `Infinity` is reserved for
				// if/when a real plan exceeds 100 members (currently
				// not the case; the migration's max is 25 for the
				// `pro` plan). Pin `Infinity` here to make the
				// semantic clearer: "this plugin's built-in is
				// disabled; our hook is the only gate."
				organizationHooks: config.pglite ? buildPlanLimitOrganizationHooks(config.pglite) : undefined,
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

/**
 * Builds the `organizationHooks` payload for the Better-Auth
 * organization plugin. The hooks enforce the `max_members` plan
 * limit at both invite-creation and accept-invitation time, mirroring
 * the publish route's `max_private_packs` gate.
 *
 * The hooks fire on every path that lands on Better-Auth's
 * `/api/auth/organization/{invite-member,accept-invitation}` routes
 * (including the `/v1/orgs/:slug/*` registry routes that proxy to
 * them). Closing the gate HERE rather than duplicating it on each
 * route preserves the contract that plan-limit enforcement is a
 * single seam surface — `checkPlanLimit()` is the only place that
 * reads `plan_limits` and decides between an OK and a reject verdict.
 *
 * The hooks throw an `APIError` (FORBIDDEN status, custom body shape)
 * rather than returning a verdict object. Better-Auth's
 * exception-to-response adapter passes the `body` through as the
 * response JSON, so the body fields are exactly what callers see.
 * The `code` is `PLAN_MEMBER_LIMIT_REACHED` (a registry-private
 * discriminator that the Hono api-key mount's 403→401 translator
 * ignores — it's not in the credential-rejection code set, so a
 * 403 here stays 403, which matches the publish route's behavior).
 */
function buildPlanLimitOrganizationHooks(pglite: PGlite): {
	beforeCreateInvitation: (data: {
		invitation: { organizationId: string; email: string; role: string }
		inviter: { id: string } & Record<string, unknown>
		organization: { id: string } & Record<string, unknown>
	}) => Promise<void>
	beforeAcceptInvitation: (data: {
		invitation: { organizationId: string } & Record<string, unknown>
		user: { id: string } & Record<string, unknown>
		organization: { id: string } & Record<string, unknown>
	}) => Promise<void>
} {
	const enforceMaxMembers = async (orgId: string, where: "create-invitation" | "accept-invitation"): Promise<void> => {
		const verdict = await checkPlanLimit(pglite, orgId, "max_members")
		if (verdict.ok) return
		// The body shape mirrors the publish route's plan-limit
		// rejection so the two seams emit identical JSON fields; the
		// `code` discriminator is a stable string a caller can
		// branch on without parsing free text. Better-Auth's
		// exception-to-response passes the body verbatim through
		// `JSON.stringify`, so the 403 response body is exactly:
		//
		//   { error, limit, plan, usage, limitValue, code, where }
		//
		// where `where` makes the gate location obvious in logs
		// (rejected at create-time vs rejected at accept-time — the
		// two paths have different remediation for the caller).
		throw new APIError("FORBIDDEN", {
			error: verdict.message,
			limit: verdict.capability,
			plan: verdict.plan,
			usage: verdict.usage,
			limitValue: verdict.limit,
			code: "PLAN_MEMBER_LIMIT_REACHED",
			where,
		})
	}
	return {
		beforeCreateInvitation: async (data) => {
			await enforceMaxMembers(data.invitation.organizationId, "create-invitation")
		},
		beforeAcceptInvitation: async (data) => {
			await enforceMaxMembers(data.invitation.organizationId, "accept-invitation")
		},
	}
}
