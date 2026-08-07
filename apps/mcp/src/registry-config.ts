import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	BAKA_PROJECT_PATHS,
	normalizeRegistryUrl,
	type RegistryConfigMap,
	resolveRegistryUrlList,
} from "@repo/protocol"

/**
 * MCP registry config resolution (architecture §8 decisions 4 + 27; VAL-DISC-029).
 *
 * Mirrors `apps/cli/src/lib/registry-config.ts` exactly: the same
 * env > project settings > default chain resolves to the same list
 * of registries for both surfaces, so the MCP `baka_registry_*`
 * tools and the CLI's `baka registry *` / `baka search` / `baka
 * install` commands always agree on which registry they are
 * talking to.
 *
 * The MCP server has no CLI flags, so the MCP wrapper calls the
 * protocol helper with `flagValue: undefined`; the chain is
 * therefore `BAKA_REGISTRY_URL` > `.baka/settings.json` registries
 * list > `http://localhost:4300`. The CLI's identical helper adds
 * the `--registry` flag at the top — but the underlying protocol
 * helper is the same function both call.
 *
 * Credential resolution (architecture §8 decision 4 + decision 33):
 * the per-registry API key lives at `${BAKA_HOME:-$HOME/.baka}/config.json`
 * under a top-level `registries: { <normalized-url>: { apiKey } }`
 * map. The CLI writes it via `writeRegistryCredential`; the MCP
 * reads it verbatim. A missing or corrupt config degrades to "no
 * credentials stored" — anonymous registry reads for `public`
 * modules still succeed (decision 23: previews of public modules
 * are served without authentication), and `org`-visibility reads
 * fail honestly with the registry's 401/404 instead of crashing
 * the server.
 *
 * The MCP server NEVER writes to the user config; it is a read-only
 * consumer. The CLI owns write paths (login/logout/whoami/publish).
 * Architecture §8 decision 9: "MCP has no install tool" — install
 * is the CLI's job, so the credentials the MCP surfaces are the
 * ones the CLI stored. There is no MCP `login` tool; the user runs
 * `baka registry login` at the terminal.
 */

interface ResolveOptions {
	/** Env to read `BAKA_REGISTRY_URL` from (defaults to process.env). */
	env?: NodeJS.ProcessEnv
	/** Pre-loaded project registries (test seam). */
	projectRegistries?: string[]
}

/**
 * Returns the ordered list of registry URLs the MCP should query
 * for a given cwd. The order is the chain order: env > project
 * settings > default. Precedence matches the CLI surface
 * (VAL-DISC-029).
 */
export function resolveMcpRegistryUrls(cwd: string | undefined, opts: ResolveOptions = {}): string[] {
	const projectRegistries = opts.projectRegistries ?? readProjectRegistries(cwd)
	return resolveRegistryUrlList(undefined, {
		env: opts.env ?? process.env,
		projectRegistries,
	})
}

/**
 * Reads `.baka/settings.json` from `cwd` and extracts the
 * `registries` list. The shape is identical to the CLI's loader
 * (decision 27 + VAL-DISC-039: a missing, corrupt, or non-array
 * `registries` field all resolve to "no project registries" — the
 * user's mistake never silently swaps the URL the MCP actually
 * queried).
 */
function readProjectRegistries(cwd: string | undefined): string[] {
	if (cwd === undefined) return []
	const path = join(cwd, BAKA_PROJECT_PATHS.ROOT, "settings.json")
	if (!existsSync(path)) return []
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, "utf-8")) as unknown
	} catch {
		return []
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return []
	const registries = (raw as { registries?: unknown }).registries
	if (!Array.isArray(registries)) return []
	const out: string[] = []
	for (const entry of registries) {
		if (typeof entry === "string" && entry.length > 0) out.push(entry)
	}
	return out
}

/**
 * Returns the resolved path to the user config file
 * `${BAKA_HOME:-$HOME/.baka}/config.json`. Mirrors
 * `@repo/agent-engine`'s `userConfigPath()` but stays inside the
 * MCP package so the registry code can be reasoned about without
 * crossing the agent-engine boundary. The two paths always agree
 * — same env handling, same fallback.
 */
function userConfigPath(): string {
	const bakaHome = process.env.BAKA_HOME
	if (typeof bakaHome === "string" && bakaHome.length > 0) {
		return join(bakaHome, "config.json")
	}
	const home = process.env.HOME ?? process.env.USERPROFILE
	if (typeof home !== "string" || home.length === 0) {
		return join("/tmp", ".baka", "config.json")
	}
	return join(home, ".baka", "config.json")
}

/**
 * Reads the full per-registry credential map from the user config.
 * Corrupt JSON or a malformed entry degrades to "no credentials
 * stored" — the MCP server is read-only and must NOT crash on a
 * bad config file (the CLI's role store crashes; the MCP's
 * registry surface must stay alive so non-registry tools continue
 * to answer, per VAL-DISC-029 case (c): "registry tools fail per
 * VAL-DISC-028 while non-registry tools still work").
 */
function readMcpRegistryCredentials(): RegistryConfigMap {
	const path = userConfigPath()
	if (!existsSync(path)) return {}
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, "utf-8")) as unknown
	} catch {
		return {}
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {}
	const registries = (raw as { registries?: unknown }).registries
	if (registries === null || typeof registries !== "object" || Array.isArray(registries)) return {}
	const out: RegistryConfigMap = {}
	for (const [url, value] of Object.entries(registries as Record<string, unknown>)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue
		const apiKey = (value as { apiKey?: unknown }).apiKey
		if (typeof apiKey !== "string" || apiKey.length === 0) continue
		try {
			const normalized = normalizeRegistryUrl(url)
			out[normalized] = { apiKey }
		} catch {
			// A URL key the normalizer cannot parse is dropped —
			// the MCP never echoes the stored value, so a corrupt
			// key cannot leak through. The CLI's writer validates
			// the URL on write, so this branch is the corrupt-
			// write defense-in-depth.
		}
	}
	return out
}

/**
 * Returns the stored API key for one registry base URL, or
 * `undefined` when no credential is stored. The lookup normalizes
 * the URL on read so `http://localhost:4300` and
 * `http://localhost:4300/` resolve to the same entry (the CLI's
 * writer normalizes on write; we normalize again on read so a
 * future writer that forgets is silently correct).
 */
export function readMcpRegistryApiKey(url: string): string | undefined {
	const credentials = readMcpRegistryCredentials()
	let normalized: string
	try {
		normalized = normalizeRegistryUrl(url)
	} catch {
		return undefined
	}
	return credentials[normalized]?.apiKey ?? credentials[url]?.apiKey
}
