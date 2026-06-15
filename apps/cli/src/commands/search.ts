import { readCatalogSubscriptions } from "@repo/ast-tooling"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { aggregate, getBuiltInCatalog, getVerifiedList } from "../lib/marketplace-client"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

type ModuleLike = {
	name: string
	version: string
	description: string
	tier: string
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
	// Injected for tests
	subscriptions?: { catalogs: string[] }
}

export async function runSearchCommand(query: string, opts: SearchOptions = {}): Promise<void> {
	if (!query) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka search <query>")

	const clientOpts = { apiUrl: opts.apiUrl, fetch: opts.fetch }
	const builtIn = await getBuiltInCatalog(clientOpts)
	const verified = await getVerifiedList(clientOpts)
	const subs = opts.subscriptions ?? readCatalogSubscriptions()
	const verifiedUrls = verified.catalogs.map((c) => c.url)
	const allUrls = [...verifiedUrls, ...subs.catalogs]

	let communityModules: ModuleLike[] = []
	let catalogErrors: Array<{ url: string; error: string }> = []
	if (allUrls.length > 0) {
		const agg = await aggregate(allUrls, clientOpts)
		communityModules = agg.modules
		catalogErrors = agg.catalogErrors
	}

	const builtInMatches = builtIn.modules.filter((m) => matchesQuery(m, query))
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

	if (all.length === 0) {
		console.log(`no modules matching "${query}"`)
		if (catalogErrors.length > 0) {
			console.log(`(${catalogErrors.length} catalog(s) unreachable; ignored)`)
		}
		return
	}

	console.log(`\n${all.length} module(s) matching "${query}":\n`)
	for (const { module: m, tier } of all) {
		const tagStr = m.tags && m.tags.length > 0 ? `  [${m.tags.join(", ")}]` : ""
		console.log(`  [${tier}] ${m.name}  v${m.version}`)
		console.log(`    ${m.description}${tagStr}`)
	}
	console.log("")
	if (catalogErrors.length > 0) {
		console.log(`(${catalogErrors.length} catalog(s) unreachable; ignored)`)
	}
}
