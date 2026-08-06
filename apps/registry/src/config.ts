import { resolve } from "node:path"
import { z } from "zod"

/**
 * Env-driven registry config (architecture §4.1, §4.4).
 *
 * Every option has a documented default so the registry boots with zero
 * env vars set. The values are validated with zod at boot so a typo or
 * a malformed `PORT=abc` fails fast with a typed error naming the field,
 * not an opaque downstream crash.
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
})

export type RegistryConfig = z.infer<typeof ConfigSchema>

/**
 * Reads the registry config from environment variables and resolves any
 * relative paths against `cwd`. Throws on invalid input (zod issues are
 * formatted as a single human-readable message naming the field).
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
	}
}
