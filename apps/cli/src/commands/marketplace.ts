import { existsSync } from "node:fs"
import {
	addCatalogSubscription,
	installSource,
	listInstalledPackages,
	parseSource,
	projectModulesDir,
	projectSettingsPath,
	readCatalogSubscriptions,
	removeCatalogSubscription,
	removeSource,
	userCatalogsPath,
	userModulesDir,
	userSettingsPath,
} from "@repo/ast-tooling"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { getVerifiedList, lookupModule, MarketplaceHttpError } from "../lib/marketplace-client"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

// ---------------------------------------------------------------------------
// baka install <source>
// ---------------------------------------------------------------------------

interface ResolveOptions {
	fetch?: typeof fetch
	apiUrl?: string
	subscriptions?: { catalogs: string[] }
}

/**
 * Resolves a bare module name to a source string by querying the
 * marketplace API. Returns `null` only when a reachable registry answers
 * that no such module exists (HTTP 404). A registry that cannot be reached
 * at all throws (MarketplaceTransportError, naming the base URL) — the
 * caller must not confuse "the service is down" with "no such module".
 * Used by `runInstallCommand` to extend `baka install` to accept names
 * like `baka-acme-auth` in addition to the explicit source format
 * (`npm:...`, `git:...`, etc.).
 */
export async function resolveModuleName(
	name: string,
	opts: ResolveOptions = {},
): Promise<{ source: string; tier: string } | null> {
	const clientOpts = { fetch: opts.fetch, apiUrl: opts.apiUrl }
	const subs = opts.subscriptions ?? readCatalogSubscriptions()
	const verified = await getVerifiedList(clientOpts)
	const allUrls = [...verified.catalogs.map((c) => c.url), ...subs.catalogs]
	try {
		const result = await lookupModule(name, allUrls, clientOpts)
		return { source: result.module.source, tier: result.source.tier }
	} catch (err) {
		if (err instanceof MarketplaceHttpError && err.status === 404) return null
		throw err
	}
}

export async function runInstallCommand(
	source: string,
	opts: { cwd: string; scope: "project" | "user"; resolve?: ResolveOptions },
): Promise<void> {
	if (!source) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka install <source>")

	let resolvedSource = source
	try {
		parseSource(source)
	} catch {
		// Not an explicit source spec (npm:/git:/local/URL): treat it as a
		// bare module name and resolve it through the marketplace registry.
		let resolved: { source: string; tier: string } | null
		try {
			resolved = await resolveModuleName(source, opts.resolve)
		} catch (err) {
			// The registry itself is unreachable — report the transport truth
			// (which URL failed and why), never a parse error.
			const message = err instanceof Error ? err.message : String(err)
			die(BAKA_EXIT_CODE.ENGINE_ERROR, `cannot resolve "${source}": ${message}`)
		}
		if (resolved) {
			resolvedSource = resolved.source
			console.log(`resolved "${source}" -> ${resolvedSource} (${resolved.tier})`)
		} else {
			// A reachable registry answered: no such module. USER_ERROR (1) —
			// the user asked for something that does not exist.
			die(
				BAKA_EXIT_CODE.USER_ERROR,
				`module not found in the registry: "${source}". Explicit sources: npm:@scope/pkg[@ver], git:host/repo[@ref], /abs/path, ./rel/path, or https://...`,
			)
		}
	}

	const parsed = parseSource(resolvedSource)
	const settingsPath = opts.scope === "project" ? projectSettingsPath(opts.cwd) : userSettingsPath()
	const modulesDir = opts.scope === "project" ? projectModulesDir(opts.cwd) : userModulesDir()

	console.log(`installing ${parsed.type}: ${parsed.raw} -> ${modulesDir}/${parsed.moduleName} (${opts.scope} scope)`)
	try {
		const result = await installSource(resolvedSource, {
			scope: opts.scope,
			cwd: opts.cwd,
			settingsPath,
			modulesDir,
		})
		console.log(`  installed: ${result.modulePath}`)
		console.log(`  registered in: ${settingsPath}`)
	} catch (err) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `install failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

// ---------------------------------------------------------------------------
// baka remove <source>
// ---------------------------------------------------------------------------

export function runRemoveCommand(source: string, opts: { cwd: string; scope: "project" | "user" }): void {
	if (!source) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka remove <source>")
	const settingsPath = opts.scope === "project" ? projectSettingsPath(opts.cwd) : userSettingsPath()
	const modulesDir = opts.scope === "project" ? projectModulesDir(opts.cwd) : userModulesDir()
	const result = removeSource(source, { settingsPath, modulesDir })
	if (!result.removed) {
		die(BAKA_EXIT_CODE.USER_ERROR, `source not in ${opts.scope} settings: ${source}`)
	}
	console.log(`removed ${source} from ${opts.scope} settings`)
}

// ---------------------------------------------------------------------------
// baka list-packages
// ---------------------------------------------------------------------------

export function runListPackagesCommand(cwd: string): void {
	const pkgs = listInstalledPackages(cwd)
	if (pkgs.length === 0) {
		console.log("no installed packages; use `baka install <source>`")
		return
	}
	console.log(`\n${pkgs.length} package(s):\n`)
	for (const p of pkgs) {
		const exists = existsSync(p.modulePath)
		console.log(`  [${p.scope}] ${p.moduleName}`)
		console.log(`    source: ${p.source}`)
		console.log(`    path:   ${p.modulePath}${exists ? "" : " (not materialized)"}`)
	}
	console.log("")
}

// ---------------------------------------------------------------------------
// baka marketplace add | list | remove | update
//
// (Note: the install/remove/list-packages commands above operate
// on installed packages. The commands below operate on the user's
// subscribed community catalog URLs, stored in
// `~/.baka/catalogs.json`.)
// ---------------------------------------------------------------------------

export function runMarketplaceAdd(url: string, catalogsPath: string = userCatalogsPath()): void {
	if (!url) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka marketplace add <url>")
	const added = addCatalogSubscription(url, catalogsPath)
	if (added) {
		console.log(`added catalog: ${url}`)
	} else {
		console.log(`already subscribed: ${url}`)
	}
}

export function runMarketplaceList(catalogsPath: string = userCatalogsPath()): void {
	const subs = readCatalogSubscriptions(catalogsPath)
	if (subs.catalogs.length === 0) {
		console.log("no subscribed catalogs; use `baka marketplace add <url>`")
		return
	}
	console.log(`\n${subs.catalogs.length} subscribed catalog(s):\n`)
	for (const url of subs.catalogs) {
		console.log(`  ${url}`)
	}
	console.log("")
}

export function runMarketplaceRemove(url: string, catalogsPath: string = userCatalogsPath()): void {
	if (!url) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka marketplace remove <url>")
	const removed = removeCatalogSubscription(url, catalogsPath)
	if (!removed) {
		die(BAKA_EXIT_CODE.USER_ERROR, `not subscribed to: ${url}`)
	}
	console.log(`removed catalog: ${url}`)
}

export function runMarketplaceUpdate(): void {
	// v1: no-op. Catalogs are fetched on demand by `/v1/aggregate` and
	// `/v1/modules/:name`; the server-side cache (5m) handles staleness.
	// This command exists so users can wire it into a cron / daily
	// invocation once server-side warming lands.
	console.log("(no-op in v1; catalogs are fetched on demand and cached for 5m server-side)")
}
