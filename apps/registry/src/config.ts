import { resolve } from "node:path"
import { z } from "zod"
import { parseApiKeyRateLimitEnv } from "./auth/better-auth"

/**
 * Env-driven registry config (architecture §4.1, §4.4).
 *
 * Every option has a documented default so the registry boots with zero
 * env vars set. The values are validated with zod at boot so a typo or
 * a malformed `PORT=abc` fails fast with a typed error naming the field,
 * not an opaque downstream crash.
 *
 * The API-key rate limit env vars (`REGISTRY_API_KEY_RATE_LIMIT*`) are
 * NOT in the zod schema because the env parser applies the documented
 * "unset = upstream default" policy per field rather than rejecting
 * any malformed value. They are merged into the returned config after
 * zod validation so a typo in `MAX=abc` is silently ignored rather than
 * refusing to boot (the documented contract).
 */

const ConfigSchema = z.object({
	/** HTTP listener port (decision: default 4300). `0` means OS-assigned (tests). */
	port: z.coerce.number().int().nonnegative().default(4300),
	/** Public base URL (used for OAuth callbacks and absolute links). */
	baseUrl: z.string().url().default("http://localhost:4300"),
	/** Directory for the registry's persistent state (PGlite + artifacts). */
	dataDir: z.string().default(".registry-data"),
	/** Subdirectory for artifact blobs (tarballs, previews). */
	storageDir: z.string().default("artifacts"),
	/** Subdirectory for PGlite's data files. */
	pgliteDir: z.string().default("pg"),
	/** Pglite socket port (used by the data layer feature; reserved here). */
	pgliteSocketPort: z.coerce.number().int().positive().default(5444),
	/** GitHub OAuth client id (architecture §4.4). */
	githubClientId: z.string().default("test-github-client-id"),
	/** GitHub OAuth client secret (architecture §4.4). */
	githubClientSecret: z.string().default("test-github-client-secret"),
	/** Secret for signing cookies/sessions. Defaults to a derived value. */
	authSecret: z.string().optional(),
	/**
	 * Operator-supplied plan overrides applied at boot (architecture
	 * §4.7, decision 3). JSON array of
	 *   `{plan, max_private_modules, max_members, max_registries}`
	 * entries; each is upserted into `plan_limits`. When unset the
	 * migration-0002 defaults (`free`/`pro`) are the active set.
	 */
	seedPlans: z.string().optional(),
	/**
	 * The slug of the official org (architecture §8 decisions 26 and 29).
	 * Bare-name publishing and resolution map to this scope; the registry
	 * creates the org at boot if absent. Defaults to `baka` so the
	 * upstream registry-binary behavior is preserved with no env config.
	 */
	officialOrg: z.string().min(1).default("baka"),
	/**
	 * Comma-separated list of identities authorized to publish to the
	 * official scope (architecture §8 decision 29). Each entry is either
	 * a raw Better-Auth API key (starts with the configured prefix, e.g.
	 * `baka_…`) or a numeric GitHub user ID. At boot the registry resolves
	 * entries to users and grants them `owner` role on the official org;
	 * GitHub user IDs that match no existing account are skipped.
	 * Empty / unset means nobody can publish to the official scope.
	 */
	officialPublishers: z.string().optional(),
})

export type RegistryConfig = z.infer<typeof ConfigSchema> & {
	/** Parsed from `REGISTRY_API_KEY_RATE_LIMIT*` env vars (see `.env.example`). */
	apiKeyRateLimit?: ReturnType<typeof parseApiKeyRateLimitEnv>
}

/**
 * Reads the registry config from environment variables and resolves any
 * relative paths against `cwd`. Throws on invalid input (zod issues are
 * formatted as a single human-readable message naming the field).
 *
 * The API-key rate limit env vars (`REGISTRY_API_KEY_RATE_LIMIT*`) are
 * parsed via `parseApiKeyRateLimitEnv` and attached to the returned
 * config so the Better-Auth bootstrap can wire them into the
 * `apiKey` plugin. When unset, the parser returns undefined and the
 * upstream plugin defaults (10 requests per 24h per key) apply
 * unchanged — see `.env.example` for the documented knobs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): RegistryConfig {
	const parsed = ConfigSchema.safeParse({
		port: env.PORT,
		baseUrl: env.BASE_URL,
		dataDir: env.DATA_DIR,
		storageDir: env.STORAGE_DIR,
		pgliteDir: env.PGLITE_DIR,
		pgliteSocketPort: env.PGLITE_SOCKET_PORT,
		githubClientId: env.GITHUB_CLIENT_ID,
		githubClientSecret: env.GITHUB_CLIENT_SECRET,
		authSecret: env.AUTH_SECRET,
		seedPlans: env.REGISTRY_SEED_PLANS,
		officialOrg: env.REGISTRY_OFFICIAL_ORG,
		officialPublishers: env.REGISTRY_OFFICIAL_PUBLISHERS,
	})
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")
		throw new Error(`invalid registry config:\n${issues}`)
	}
	const cfg = parsed.data
	const dataDir = resolve(cwd, cfg.dataDir)
	return {
		...cfg,
		dataDir,
		storageDir: resolve(dataDir, cfg.storageDir),
		pgliteDir: resolve(dataDir, cfg.pgliteDir),
		apiKeyRateLimit: parseApiKeyRateLimitEnv(env),
	}
}
