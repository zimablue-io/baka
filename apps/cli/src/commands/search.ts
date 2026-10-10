import { BAKA_EXIT_CODE } from "@repo/protocol"
import { die } from "../die"
import {
	getCatalog,
	type RegistryCatalogEntry,
	RegistryHttpError,
	RegistryTransportError,
} from "../lib/registry-client"
import { resolveRegistryList } from "../lib/registry-config"

/**
 * `baka search <query>` (architecture §8 decisions 4 + 27; milestone 5
 * cli-search-multiregistry).
 *
 * Multi-registry merge with per-source attribution and per-source
 * failure isolation:
 *
 *   - One `GET /v1/packs` call per configured registry (decision 4
 *     precedence: `--registry` > `BAKA_REGISTRY_URL` > project
 *     settings > default localhost:4300).
 *   - Each catalog entry becomes one search hit annotated with the
 *     source registry's base URL in the `registry` field
 *     (decision 27).
 *   - One unreachable registry becomes a per-source `warning` entry;
 *     the search continues. Only when EVERY configured source fails
 *     does the command die with EXIT 2 and an honest error naming
 *     each URL (decision 4 + decision 27 + VAL-DISC-013).
 *   - Results are ordered by registry config order, then by
 *     scope+name (decision 27: first-listed registry wins;
 *     intra-registry ordering is stable).
 *
 * Query matching is case-insensitive substring against
 * `name`, `description`. Tier, scope, and version are surfaced as
 * separate hit fields so a consumer can filter the JSON without
 * parsing text.
 */

interface SearchHit {
	scope: string
	name: string
	version: string | null
	tier: string
	description: string
	registry: string
}

function matchesQuery(entry: RegistryCatalogEntry, q: string): boolean {
	const needle = q.toLowerCase()
	if (entry.name.toLowerCase().includes(needle)) return true
	if (entry.description.toLowerCase().includes(needle)) return true
	if (entry.scope.toLowerCase().includes(needle)) return true
	return false
}

interface SourceWarning {
	source: string
	error: string
}

interface SourceResult {
	baseUrl: string
	packs: RegistryCatalogEntry[]
}

interface SearchOptions {
	fetch?: typeof fetch
	/** Test/injection seam — when set, bypasses the resolver. */
	registries?: string[]
	/**
	 * Single-registry flag (`--registry` from the CLI). When set the
	 * resolver is bypassed and the search targets ONLY this URL,
	 * producing a one-element list — same precedence rule as every
	 * other CLI command (decision 4: flag wins).
	 */
	registry?: string
	/** cwd for the `.baka/settings.json` project registries load. */
	cwd?: string
	/** Test/injection seam for the env read. */
	env?: NodeJS.ProcessEnv
	/** JSON output. */
	json?: boolean
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message
	return String(err)
}

interface FetchedSource {
	baseUrl: string
	packs: RegistryCatalogEntry[] | null
	error: SourceWarning["error"] | null
}

/**
 * Queries every configured registry's `/v1/packs` endpoint and
 * groups the responses by source. Per-source failures are captured
 * (not thrown) so the caller can decide whether the overall result
 * set is empty-but-valid (no warnings → return 0) or
 * empty-due-to-network (every source failed → exit 2).
 */
async function fetchAllSources(
	registries: string[],
	fetchImpl: typeof fetch | undefined,
): Promise<{ results: SourceResult[]; warnings: SourceWarning[] }> {
	const fetched: FetchedSource[] = await Promise.all(
		registries.map(async (base) => {
			try {
				const packs = await getCatalog({ baseUrl: base, fetchImpl })
				return { baseUrl: base, packs, error: null }
			} catch (err) {
				return {
					baseUrl: base,
					packs: null,
					error:
						err instanceof RegistryTransportError
							? err.message
							: err instanceof RegistryHttpError
								? `HTTP ${err.status}: ${err.message}`
								: errorMessage(err),
				}
			}
		}),
	)
	const results: SourceResult[] = []
	const warnings: SourceWarning[] = []
	for (const r of fetched) {
		if (r.packs === null) {
			warnings.push({ source: r.baseUrl, error: r.error ?? "unknown failure" })
			continue
		}
		results.push({ baseUrl: r.baseUrl, packs: r.packs })
	}
	return { results, warnings }
}

function buildHits(results: SourceResult[], query: string): SearchHit[] {
	const hits: SearchHit[] = []
	for (const src of results) {
		for (const entry of src.packs) {
			if (!matchesQuery(entry, query)) continue
			hits.push({
				scope: entry.scope,
				name: entry.name,
				version: entry.latestVersion,
				tier: entry.tier,
				description: entry.description,
				registry: src.baseUrl,
			})
		}
	}
	// Stable: first-listed registry's hits first (already true by
	// construction); within each source, alphabetical by scope+name.
	hits.sort((a, b) => {
		if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1
		if (a.name !== b.name) return a.name < b.name ? -1 : 1
		if (a.registry !== b.registry) return a.registry < b.registry ? -1 : 1
		return 0
	})
	return hits
}

function printHuman(hits: SearchHit[], warnings: SourceWarning[], query: string): void {
	if (hits.length === 0) {
		console.log(`no packs matching "${query}"`)
	} else {
		console.log(`\n${hits.length} pack(s) matching "${query}":\n`)
		for (const h of hits) {
			const verSuffix = h.version ? `  v${h.version}` : ""
			console.log(`  @${h.scope}/${h.name}${verSuffix}  [${h.tier}]  (source: ${h.registry})`)
			console.log(`    ${h.description}`)
		}
		console.log("")
	}
	for (const w of warnings) {
		console.log(`warning: source unreachable: ${w.source} (${w.error})`)
	}
}

function printJson(hits: SearchHit[], warnings: SourceWarning[], query: string): void {
	const payload = { query, results: hits, warnings }
	console.log(JSON.stringify(payload, null, 2))
}

export async function runSearchCommand(query: string, opts: SearchOptions = {}): Promise<void> {
	if (!query) die(BAKA_EXIT_CODE.BAD_INPUT, "usage: baka search <query> [--registry <url>] [--json]")

	const registries = opts.registries ?? resolveRegistryList(opts.registry, { cwd: opts.cwd, env: opts.env })
	const { results, warnings } = await fetchAllSources(registries, opts.fetch)

	const hits = buildHits(results, query)

	// VAL-DISC-013: when EVERY configured source failed to even
	// respond, the search dies with FAILED (2) and an honest
	// error naming each URL + transport cause. We distinguish
	// transport truth ("registry unreachable") from a clean empty
	// result set ("no packs matched"); users must be able to
	// branch without parsing prose.
	if (hits.length === 0 && results.length === 0 && warnings.length > 0) {
		const lines = warnings.map((w) => `  - ${w.source}: ${w.error}`).join("\n")
		die(BAKA_EXIT_CODE.FAILED, `baka search failed: every configured registry is unreachable\n${lines}`)
	}

	if (opts.json) {
		printJson(hits, warnings, query)
		return
	}
	printHuman(hits, warnings, query)
}
