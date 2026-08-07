import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	BAKA_PROJECT_PATHS,
	resolveRegistryUrlList as resolveRegistryUrlListPure,
	resolveSingleRegistryUrl as resolveSingleRegistryUrlPure,
} from "@repo/protocol"

/**
 * Registry URL config resolution (architecture §8 decisions 4 + 27).
 *
 * The same resolver backs every CLI surface that talks to a registry
 * (search, install, login/whoami, publish, org). This file is a
 * thin wrapper around the protocol-level chain — it loads
 * `.baka/settings.json` from cwd and hands the raw list to the
 * protocol helper, so the chain semantics live in
 * `@repo/protocol/registry-config` (the single source of truth the
 * MCP registry tools also call into). A future fix lands in one
 * place; a future regression surfaces identically on both surfaces.
 *
 * Chain (architecture §8 decision 4):
 *
 *   1. `--registry <url>` flag on the CLI invocation (wins outright)
 *   2. `BAKA_REGISTRY_URL` env var (overrides project settings)
 *   3. `.baka/settings.json` `registries` LIST for the current cwd
 *      (only consumed by multi-registry commands; the first entry
 *       is what single-registry commands pick)
 *   4. `http://localhost:4300` (the only documented default)
 *
 * For a single-registry command (`baka install`, `baka publish`,
 * `baka registry login`) the resolver returns ONE URL. For a
 * multi-registry command (`baka search`, bare-name `baka install`)
 * the resolver returns a LIST — first-listed-wins on scoped-name
 * conflicts, per decision 4; the per-hit attribution `registry`
 * field surfaces the source base URL, per decision 27.
 *
 * The project file format is `.baka/settings.json` with top-level
 * `registries: string[]`. A missing file, a corrupt file, or a
 * non-list `registries` field is treated as "no project registries"
 * so a broken config falls back to the env or the default (the
 * user's mistake never silently swaps the URL the CLI actually
 * queried — VAL-DISC-039).
 */

/** Per-project registries list as read from `.baka/settings.json`. */
export type ProjectRegistries = string[]

interface ResolveOptions {
	/** Process cwd (used to locate `.baka/settings.json`). */
	cwd?: string
	/** Env to read `BAKA_REGISTRY_URL` from (defaults to process.env). */
	env?: NodeJS.ProcessEnv
	/**
	 * Pre-loaded project registries (test seam). When undefined the
	 * resolver reads `.baka/settings.json` itself; when supplied the
	 * caller controls the value (used by tests that exercise the
	 * malformed-settings branches deterministically).
	 */
	projectRegistries?: ProjectRegistries
}

/**
 * Resolves the single registry URL a single-registry command should
 * use. Precedence is flag > env > project-settings[0] > default.
 * The chain is implemented in `@repo/protocol` so MCP and CLI agree.
 */
export function resolveSingleRegistryUrl(flagValue: string | undefined, opts: ResolveOptions = {}): string {
	const projectRegistries = opts.projectRegistries ?? readProjectRegistries(opts.cwd)
	return resolveSingleRegistryUrlPure(flagValue, { env: opts.env, projectRegistries })
}

/**
 * Resolves the list of registry URLs a multi-registry command should
 * query. The flag replaces the entire list (one explicit URL pins
 * the search to that one registry); the env becomes a one-element
 * list; project settings contribute their full ordered list; the
 * default is `[http://localhost:4300]` only when nothing else is
 * configured. The chain is implemented in `@repo/protocol` so MCP
 * and CLI agree.
 */
export function resolveRegistryList(flagValue: string | undefined, opts: ResolveOptions = {}): string[] {
	const projectRegistries = opts.projectRegistries ?? readProjectRegistries(opts.cwd)
	return resolveRegistryUrlListPure(flagValue, { env: opts.env, projectRegistries })
}

/**
 * Reads `.baka/settings.json` from `cwd` and extracts the
 * `registries` list. Returns an empty list for: a missing file, a
 * syntactically invalid JSON file, or a `registries` field that is
 * not an array of strings. The contract is "no project registries"
 * for every malformed input — never "the user's mistake is invisible
 * to the resolver" (VAL-DISC-039).
 */
function readProjectRegistries(cwd: string | undefined): ProjectRegistries {
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
