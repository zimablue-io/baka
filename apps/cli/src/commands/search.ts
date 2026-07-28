import { readCatalogSubscriptions } from "@repo/ast-tooling"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { aggregate, getBuiltInCatalog, getMarketplaceApiUrl, getVerifiedList } from "../lib/marketplace-client"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

type ModuleLike = {
	name: string
	version: string
	description: string
	tier: string
	source: string
	tags?: string[]
	keywords?: string[]
	category?: string
}

function matchesQuery(m: ModuleLike, q: string): boolean {
	const lower = q.toLowerCase()
	if (m.name.toLowerCase().includes(lower)) return true
	if (m.description.toLowerCase().includes(lower)) return true
	if (m.tags?.some((t) => t.toLowerCase().includes(lower))) return true
	if (m.keywords?.some((k) => k.toLowerCase().includes(lower))) return true
	if (m.category?.toLowerCase().includes(lower)) return true
	return false
}

const TIER_ORDER: Record<string, number> = {
	"built-in": 0,
	verified: 1,
	community: 2,
}

export interface SearchOptions {
	fetch?: typeof fetch
	apiUrl?: string
	json?: boolean
	// Injected for tests
	subscriptions?: { catalogs: string[] }
}

interface SourceWarning {
	source: string
	error: string
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export async function runSearchCommand(query: string, opts: SearchOptions = {}): Promise<void> {
	if (!query) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka search <query>")

	const clientOpts = { apiUrl: opts.apiUrl, fetch: opts.fetch }
	const base = opts.apiUrl ?? getMarketplaceApiUrl()
	// Every catalog source is queried independently: one unreachable source
	// degrades the result set with a named warning instead of killing the
	// whole command. Only when EVERY source fails does the command fail.
	const warnings: SourceWarning[] = []

	let builtIn: ModuleLike[] = []
	let builtInFailed = false
	try {
		builtIn = (await getBuiltInCatalog(clientOpts)).modules
	} catch (err) {
		builtInFailed = true
		warnings.push({ source: `${base}/v1/built-in`, error: errorMessage(err) })
	}

	let verifiedUrls: string[] = []
	let verifiedFailed = false
	try {
		verifiedUrls = (await getVerifiedList(clientOpts)).catalogs.map((c) => c.url)
	} catch (err) {
		verifiedFailed = true
		warnings.push({ source: `${base}/v1/verified`, error: errorMessage(err) })
	}

	const subs = opts.subscriptions ?? readCatalogSubscriptions()
	const allUrls = [...verifiedUrls, ...subs.catalogs]

	let communityModules: ModuleLike[] = []
	let aggregateFailed = false
	if (allUrls.length > 0) {
		try {
			const agg = await aggregate(allUrls, clientOpts)
			communityModules = agg.modules
			for (const ce of agg.catalogErrors) {
				warnings.push({ source: ce.url, error: ce.error })
			}
		} catch (err) {
			aggregateFailed = true
			warnings.push({ source: `${base}/v1/aggregate`, error: errorMessage(err) })
		}
	}

	const everySourceFailed = builtInFailed && verifiedFailed && (allUrls.length === 0 || aggregateFailed)
	if (everySourceFailed) {
		const lines = warnings.map((w) => `  - ${w.source}: ${w.error}`).join("\n")
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `baka search failed: every catalog source is unreachable (${base})\n${lines}`)
	}

	const builtInMatches = builtIn.filter((m) => matchesQuery(m, query))
	const communityMatches = communityModules.filter((m) => matchesQuery(m, query))

	const all = [
		...builtInMatches.map((m) => ({ module: m, tier: m.tier })),
		...communityMatches.map((m) => ({ module: m, tier: m.tier })),
	].sort((a, b) => {
		const ta = TIER_ORDER[a.tier] ?? 99
		const tb = TIER_ORDER[b.tier] ?? 99
		if (ta !== tb) return ta - tb
		return a.module.name.localeCompare(b.module.name)
	})

	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					query,
					results: all.map(({ module: m, tier }) => ({
						name: m.name,
						version: m.version,
						description: m.description,
						tier,
						tags: m.tags ?? [],
						source: m.source,
					})),
					warnings,
				},
				null,
				2,
			),
		)
		return
	}

	if (all.length === 0) {
		console.log(`no modules matching "${query}"`)
	} else {
		console.log(`\n${all.length} module(s) matching "${query}":\n`)
		for (const { module: m, tier } of all) {
			const tagStr = m.tags && m.tags.length > 0 ? `  [${m.tags.join(", ")}]` : ""
			console.log(`  [${tier}] ${m.name}  v${m.version}`)
			console.log(`    ${m.description}${tagStr}`)
		}
		console.log("")
	}
	for (const w of warnings) {
		console.log(`warning: source unreachable: ${w.source} (${w.error})`)
	}
}
