import { existsSync } from "node:fs"
import {
	installSource,
	listInstalledPackages,
	parseSource,
	projectModulesDir,
	projectSettingsPath,
	removeSource,
	userModulesDir,
	userSettingsPath,
} from "@repo/ast-tooling"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { getModuleDetail, RegistryHttpError, RegistryTransportError } from "../lib/registry-client"
import { resolveRegistryList } from "../lib/registry-config"

/**
 * `baka install <source>` and `baka remove <source>` commands
 * (architecture §5.1, milestone 5).
 *
 * The legacy `baka marketplace add|list|remove|update` group is
 * removed: the marketplace catalog surface (`apps/api`,
 * `~/.baka/catalogs.json`) was deleted in milestone 2 / folded
 * into the registry. Registry resolution now lives at
 * `<cwd>/.baka/settings.json` `registries` — a list the user edits
 * directly. The cli surfaces that need an aggregated catalog use
 * `baka search`, which queries every registry in that list with
 * per-source attribution (see `commands/search.ts`). The bare-name
 * install path below queries the same registries in precedence
 * order, first-found-wins (decision 4).
 *
 * Removal flow is unchanged: `baka remove <source>` strips the
 * project or user scope entry plus its materialized module dir.
 */

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

interface ResolveOptions {
	fetch?: typeof fetch
	/**
	 * Test/injection seam — when set, bypasses the resolver and
	 * uses the supplied list (order preserved).
	 */
	registries?: string[]
	/** Test/injection seam. */
	cwd?: string
	/** Test/injection seam. */
	env?: NodeJS.ProcessEnv
}

/**
 * Possible result of looking up a bare module name across the
 * configured registries. `source: null` means no registry returned
 * 200 (either the module is missing on every registry or every
 * registry is unreachable — the caller surfaces the distinguishing
 * message from `error`).
 */
interface ResolvedRegistryModule {
	source: string | null
	tier: string | null
	registry: string | null
	error?: string
}

/**
 * Parses an install spec into scope + name. The shapes accepted:
 *   @scope/name        — bare scoped look-up
 *   @scope/name@ver    — pinned scoped version
 *   @/name             — bare-name (official scope), no scope
 *   name               — bare-name, no scope
 *   name@ver           — pinned bare-name version
 * Returns null when the spec is not a bare/scope identifier (i.e.
 * the caller should try `parseSource` for npm:/git:/path). Used
 * to distinguish "the user wants registry resolution" from "the
 * user gave a literal source URI".
 */
function tryParseBareOrScope(
	spec: string,
): { scope: string | null; name: string; pinnedVersion: string | null } | null {
	const trimmed = spec.trim()
	if (trimmed.length === 0) return null
	// Reject anything that looks like an explicit source URI before
	// touching the registry surface — npm:/git:/https/absolute/relative
	// all go through `parseSource` instead.
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("./") ||
		trimmed.startsWith("../") ||
		trimmed.startsWith("~") ||
		/^https?:\/\//.test(trimmed) ||
		/^ssh:\/\//.test(trimmed) ||
		/[^/]+@[^/]+:/.test(trimmed)
	) {
		return null
	}
	const at = trimmed.lastIndexOf("@")
	let body = trimmed
	let pinnedVersion: string | null = null
	if (at > 0 && /^[a-z0-9._-]+$/i.test(trimmed.slice(at + 1))) {
		body = trimmed.slice(0, at)
		pinnedVersion = trimmed.slice(at + 1)
	} else if (at === 0) {
		// `@scope/name` — leading `@`, no version yet.
		body = trimmed
	}
	if (!body.startsWith("@")) {
		// Bare-name path. `parseSource` would reject the spec
		// because it has no `:` prefix; we treat it as a name under
		// the official scope.
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(body)) return null
		return { scope: null, name: body, pinnedVersion }
	}
	const rest = body.slice(1)
	const slash = rest.indexOf("/")
	if (slash <= 0 || slash === rest.length - 1) return null
	const scope = rest.slice(0, slash)
	const name = rest.slice(slash + 1)
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(scope)) return null
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null
	return { scope, name, pinnedVersion }
}

/**
 * Walks `registries` in order, asking each one for the module. The
 * first registry that returns 200 wins; subsequent registries are
 * not queried. A non-2xx response other than 404 throws
 * `RegistryHttpError` (the caller surfaces the registry's typed
 * message verbatim). Transport failures throw
 * `RegistryTransportError`; an unreachable registry is a
 * USER_ERROR only when it is the ONLY configured registry, otherwise
 * the loop just falls through to the next one (decision 4: first-
 * listed registry wins; transport is not a refusal when other
 * registries remain).
 */
export async function resolveRegistryModule(spec: string, opts: ResolveOptions = {}): Promise<ResolvedRegistryModule> {
	const parsed = tryParseBareOrScope(spec)
	if (parsed === null) {
		return { source: null, tier: null, registry: null, error: `spec is not a bare/scope identifier: ${spec}` }
	}
	const registries = opts.registries ?? resolveRegistryList(undefined, { cwd: opts.cwd, env: opts.env })
	const scopeForFetch = parsed.scope ?? "baka"
	const fetchImpl = opts.fetch
	let lastTransport: string | null = null
	let lastNotFound = false
	for (const baseUrl of registries) {
		try {
			const detail = await getModuleDetail({
				baseUrl,
				scope: scopeForFetch,
				name: parsed.name,
				fetchImpl,
			})
			if (detail === null) {
				lastNotFound = true
				continue
			}
			if (!detail.latestVersion) {
				// Module exists but has no ready version — same as
				// "not installable" for the install path; keep looking.
				lastNotFound = true
				continue
			}
			return {
				source: `@${detail.scope}/${detail.name}@${detail.latestVersion}`,
				tier: detail.tier,
				registry: baseUrl,
			}
		} catch (err) {
			if (err instanceof RegistryTransportError) {
				lastTransport = err.message
				continue
			}
			if (err instanceof RegistryHttpError) {
				// Anything other than 404 is a hard registry error —
				// don't silently try the next registry when one
				// answered with a typed error (the calling installer
				// needs to know it's a 401 / 403 / 5xx, not a "not
				// found").
				throw err
			}
			throw err
		}
	}
	if (lastTransport !== null) {
		return { source: null, tier: null, registry: null, error: lastTransport }
	}
	if (lastNotFound) {
		return {
			source: null,
			tier: null,
			registry: null,
			error:
				parsed.scope === null
					? `module '${parsed.name}' not found in any configured registry (bare names resolve against the registry serving the official scope; add a registry to your project's .baka/settings.json or use --registry)`
					: `module '${parsed.scope}/${parsed.name}' not found in any configured registry`,
		}
	}
	return {
		source: null,
		tier: null,
		registry: null,
		error: `no registries configured; add one with --registry <url> or BAKA_REGISTRY_URL`,
	}
}

/**
 * Resolves a bare module name to an installable source string by
 * querying every configured registry in order (first-found-wins,
 * decision 4). Returns `null` ONLY when at least one registry
 * answered that no such module exists. A registry that cannot be
 * reached at all throws — the caller must distinguish "the service
 * is down" from "the service answered" (VAL-DISC-039 + the
 * foundation honesty contract).
 *
 * Accepts scoped names (`@scope/name`), bare names (`baka-base`),
 * and pinned versions (`@scope/name@1.2.3`, `name@1.2.3`). Explicit
 * source URIs (npm:/git:/path/url) are returned unchanged — they
 * don't need registry resolution.
 */

/**
 * `baka install <source>` (architecture §5.1, decision 4).
 *
 * Resolution precedence for the input spec:
 *   1. Explicit source URI (npm:/git:/path/url) — already absolute.
 *   2. Bare-name or `@scope/name` — resolved through the
 *      configured registries (multi-registry, first-found-wins).
 *
 * Install behavior is unchanged otherwise: `installSource`
 * registers the source string in `<cwd>/.baka/settings.json`
 * (project scope) or `${BAKA_HOME:-$HOME/.baka}/settings.json`
 * (user scope) and materializes the module on disk.
 */
export async function runInstallCommand(
	source: string,
	opts: { cwd: string; scope: "project" | "user"; resolve?: ResolveOptions },
): Promise<void> {
	if (!source) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka install <source>")

	let resolvedSource = source
	let resolvedFromRegistry: { source: string; tier: string; registry: string } | null = null

	try {
		parseSource(source)
	} catch {
		// Not an explicit source spec; treat as a bare or scoped
		// module name and resolve through the registries.
		let resolution: Awaited<ReturnType<typeof resolveRegistryModule>>
		try {
			resolution = await resolveRegistryModule(source, opts.resolve)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			die(BAKA_EXIT_CODE.ENGINE_ERROR, `cannot resolve "${source}": ${message}`)
		}
		if (resolution.source !== null && resolution.tier !== null && resolution.registry !== null) {
			resolvedFromRegistry = {
				source: resolution.source,
				tier: resolution.tier,
				registry: resolution.registry,
			}
			resolvedSource = resolution.source
			console.log(`resolved "${source}" via ${resolution.registry} -> ${resolvedSource} [${resolution.tier}]`)
		} else if (resolution.error) {
			// Distinguish transport truth from "the registry answered
			// no". Resolution includes the base URL it tried as the
			// registry context where relevant.
			const lowerHint = resolution.error.toLowerCase()
			if (
				lowerHint.includes("unreachable") ||
				lowerHint.includes("econnrefused") ||
				lowerHint.includes("enotfound") ||
				lowerHint.includes("fetch failed") ||
				lowerHint.includes("timed out")
			) {
				die(BAKA_EXIT_CODE.ENGINE_ERROR, `cannot resolve "${source}": ${resolution.error}`)
			}
			// Genuine not-found across every configured registry.
			die(
				BAKA_EXIT_CODE.USER_ERROR,
				`module not found in the registry: "${source}". Configure registries in .baka/settings.json or pass --registry. (${
					resolution.error
				})`,
			)
		} else {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, `cannot resolve "${source}": no registry available`)
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
		if (resolvedFromRegistry !== null) {
			console.log(`  registry source: ${resolvedFromRegistry.registry}`)
		}
	} catch (err) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `install failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/**
 * `baka remove <source>` — strips the project or user scope entry
 * plus its materialized module dir.
 */
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

/**
 * `baka list-packages` — project + user scope, project-wins on dedup.
 */
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
