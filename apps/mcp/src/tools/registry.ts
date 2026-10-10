import type {
	RegistryCatalogEntry,
	RegistryPackDetail,
	RegistryPreviewEntry,
	RegistryRecipePreview,
	RegistryVersionDetail,
} from "@repo/protocol"
import {
	getCatalog,
	getPackDetail,
	getPackPreviews,
	getRecipePreview,
	getVersionDetail,
	RegistryHttpError,
	RegistryTransportError,
} from "../registry-client.js"
import { readMcpRegistryApiKey, resolveMcpRegistryUrls } from "../registry-config.js"

// ---------------------------------------------------------------------------
// baka_registry_search (milestone 5 mcp-registry-tools; VAL-DISC-024 / 025
// / 028 / 029 / 044).
//
// Hits every configured registry (env > project settings > default),
// filters the union by the user's query (case-insensitive substring
// against scope/name/description), and returns the matched entries.
// Each hit carries the source registry base URL in the `registry`
// field per architecture §8 decision 27.
//
// Honest degradation:
//   - A transport failure on a single source becomes a per-source
//     warning entry (`warnings: [{ source, error }]`); the search
//     CONTINUES with the remaining sources. Only when EVERY
//     configured source is unreachable does the tool return
//     `isError: true` with the per-URL transport message named
//     verbatim (VAL-DISC-028).
//   - An empty result set with zero warnings is a SUCCESS response
//     with `results: []` — never an error envelope. The contract
//     distinguishes "registry is up, no rows match" from "registry
//     is down" cleanly.
//   - A no-match search is a SUCCESS, not an error — VAL-DISC-025
//     pins this distinction so agent clients can branch on
//     `results.length === 0` vs `isError`.
// ---------------------------------------------------------------------------

interface SearchHit {
	scope: string
	name: string
	version: string | null
	tier: string
	visibility: string
	description: string
	registry: string
}

interface SearchResultPayload {
	query: string
	results: SearchHit[]
	warnings: Array<{ source: string; error: string }>
	error?: { message: string }
}

function matchesQuery(entry: RegistryCatalogEntry, q: string): boolean {
	const needle = q.toLowerCase()
	if (entry.name.toLowerCase().includes(needle)) return true
	if (entry.description.toLowerCase().includes(needle)) return true
	if (entry.scope.toLowerCase().includes(needle)) return true
	return false
}

function buildHits(results: Array<{ baseUrl: string; packs: RegistryCatalogEntry[] }>, query: string): SearchHit[] {
	const hits: SearchHit[] = []
	for (const src of results) {
		for (const entry of src.packs) {
			if (!matchesQuery(entry, query)) continue
			hits.push({
				scope: entry.scope,
				name: entry.name,
				version: entry.latestVersion,
				tier: entry.tier,
				visibility: entry.visibility,
				description: entry.description,
				registry: src.baseUrl,
			})
		}
	}
	// First-listed registry's hits first (decision 27). Stable within
	// each registry by alphabetical scope+name.
	hits.sort((a, b) => {
		if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1
		if (a.name !== b.name) return a.name < b.name ? -1 : 1
		if (a.registry !== b.registry) return a.registry < b.registry ? -1 : 1
		return 0
	})
	return hits
}

interface SearchInput {
	query: string
}

interface SearchResult {
	ok: boolean
	payload: SearchResultPayload
}

/**
 * Runs the `baka_registry_search` flow. Returns a discriminated
 * result: `ok: false` means the tool MUST return
 * `isError: true` to the MCP host; `ok: true` means the tool
 * returns the payload (possibly empty results, possibly
 * non-empty warnings) as a SUCCESS result.
 */
export async function runRegistrySearch(cwd: string, input: SearchInput): Promise<SearchResult> {
	const registries = resolveMcpRegistryUrls(cwd)
	const fetched = await Promise.all(
		registries.map(async (base) => {
			const apiKey = readMcpRegistryApiKey(base)
			try {
				const packs = await getCatalog({ baseUrl: base, apiKey })
				return { baseUrl: base, packs, warning: null }
			} catch (err) {
				return {
					baseUrl: base,
					packs: null,
					warning: transportErrorMessage(err, base, "/v1/packs"),
				}
			}
		}),
	)
	const sources: Array<{ baseUrl: string; packs: RegistryCatalogEntry[] }> = []
	const warnings: Array<{ source: string; error: string }> = []
	for (const r of fetched) {
		if (r.packs === null) {
			warnings.push({ source: r.baseUrl, error: r.warning ?? "unknown failure" })
			continue
		}
		sources.push({ baseUrl: r.baseUrl, packs: r.packs })
	}

	const hits = buildHits(sources, input.query)

	// Every source failed → the search dies honestly (VAL-DISC-028).
	// Note: a single successful source with zero hits is still a
	// SUCCESS response with an empty `results` array — that
	// distinguishes "registry down" from "no matches".
	if (hits.length === 0 && sources.length === 0 && warnings.length > 0) {
		const lines = warnings.map((w) => `  - ${w.source}: ${w.error}`).join("\n")
		return {
			ok: false,
			payload: {
				query: input.query,
				results: [],
				warnings,
				error: { message: `every configured registry is unreachable\n${lines}` },
			},
		}
	}

	return { ok: true, payload: { query: input.query, results: hits, warnings } }
}

// ---------------------------------------------------------------------------
// baka_registry_get_pack (VAL-DISC-024 / 026 / 028).
//
// Combines pack-detail + version-detail (latest ready) into one
// payload — mirrors the CLI's `baka registry info` so the MCP wire
// shape is field-for-field consistent across both surfaces. A 404
// (missing / private / tombstoned) becomes an `isError: true` with a
// named "not found" message (VAL-DISC-026).
// ---------------------------------------------------------------------------

interface GetPackInput {
	scope: string
	name: string
	version?: string
}

interface GetPackResult {
	ok: boolean
	payload:
		| {
				scope: string
				name: string
				tier: string
				visibility: string
				description: string
				latestVersion: string | null
				versions: RegistryPackDetail["versions"]
				manifest: RegistryVersionDetail["manifest"] | null
				screening: RegistryVersionDetail["screening"]
				resolvedVersion: string | null
				registry: string
		  }
		| { error: { message: string; status?: number } }
}

export async function runRegistryGetPack(cwd: string, input: GetPackInput): Promise<GetPackResult> {
	const registries = resolveMcpRegistryUrls(cwd)
	if (registries.length === 0) {
		return {
			ok: false,
			payload: { error: { message: "no registry configured (BAKA_REGISTRY_URL or .baka/settings.json `registries`)" } },
		}
	}
	// Single-registry default for a `scope/name` lookup mirrors the
	// CLI's `baka registry info` (VAL-DISC-030): first-listed
	// registry wins. Multi-registry search uses a different tool
	// (`baka_registry_search`).
	const baseUrl = registries[0] as string
	const apiKey = readMcpRegistryApiKey(baseUrl)
	let detail: RegistryPackDetail | null
	try {
		detail = await getPackDetail({ baseUrl, scope: input.scope, name: input.name, apiKey })
	} catch (err) {
		return {
			ok: false,
			payload: {
				error: {
					message: transportErrorMessage(err, baseUrl, `/v1/packs/${input.scope}/${input.name}`),
					status: err instanceof RegistryHttpError ? err.status : undefined,
				},
			},
		}
	}
	if (detail === null) {
		return {
			ok: false,
			payload: { error: { message: `pack '${input.scope}/${input.name}' was not found on registry ${baseUrl}` } },
		}
	}

	const resolvedVersion = input.version ?? detail.latestVersion
	let manifest: RegistryVersionDetail["manifest"] | null = null
	let screening: RegistryVersionDetail["screening"] = null
	if (resolvedVersion !== null) {
		let versionDetail: RegistryVersionDetail | null
		try {
			versionDetail = await getVersionDetail({
				baseUrl,
				scope: input.scope,
				name: input.name,
				version: resolvedVersion,
				apiKey,
			})
		} catch (err) {
			return {
				ok: false,
				payload: {
					error: {
						message: transportErrorMessage(err, baseUrl, `/v1/packs/${input.scope}/${input.name}/${resolvedVersion}`),
						status: err instanceof RegistryHttpError ? err.status : undefined,
					},
				},
			}
		}
		if (versionDetail !== null) {
			manifest = versionDetail.manifest
			screening = versionDetail.screening
		}
	}

	return {
		ok: true,
		payload: {
			scope: detail.scope,
			name: detail.name,
			tier: detail.tier,
			visibility: detail.visibility,
			description: detail.description,
			latestVersion: detail.latestVersion,
			versions: detail.versions,
			manifest,
			screening,
			resolvedVersion,
			registry: baseUrl,
		},
	}
}

// ---------------------------------------------------------------------------
// baka_registry_get_preview (VAL-DISC-024 / 027 / 028).
//
// Combines the previews LIST endpoint with per-recipe DETAIL fetches
// so the payload is byte-equal to the CLI's `baka registry preview
// --json` output. `rendered` carries the file CONTENTS; `needs-llm`
// carries the reason verbatim from the registry — fabricated code
// for reasoning recipes is a contract violation. Unknown packs /
// versions become a tool-level `isError: true` so the agent client
// can distinguish "registry unreachable" from "pack not found"
// (VAL-DISC-028).
// ---------------------------------------------------------------------------

interface GetPreviewInput {
	scope: string
	name: string
	version?: string
}

interface PreviewEntryPayload {
	recipeId: string
	state: "rendered" | "needs-llm"
	reason?: string
	files: Array<{ path: string; content: string; size: number; sha256: string }>
}

interface GetPreviewResult {
	ok: boolean
	payload:
		| {
				scope: string
				name: string
				version: string
				registry: string
				previews: PreviewEntryPayload[]
		  }
		| { error: { message: string; status?: number } }
}

export async function runRegistryGetPreview(cwd: string, input: GetPreviewInput): Promise<GetPreviewResult> {
	const registries = resolveMcpRegistryUrls(cwd)
	if (registries.length === 0) {
		return {
			ok: false,
			payload: { error: { message: "no registry configured (BAKA_REGISTRY_URL or .baka/settings.json `registries`)" } },
		}
	}
	const baseUrl = registries[0] as string
	const apiKey = readMcpRegistryApiKey(baseUrl)

	let detail: RegistryPackDetail | null
	try {
		detail = await getPackDetail({ baseUrl, scope: input.scope, name: input.name, apiKey })
	} catch (err) {
		return {
			ok: false,
			payload: {
				error: {
					message: transportErrorMessage(err, baseUrl, `/v1/packs/${input.scope}/${input.name}`),
					status: err instanceof RegistryHttpError ? err.status : undefined,
				},
			},
		}
	}
	if (detail === null) {
		return {
			ok: false,
			payload: { error: { message: `pack '${input.scope}/${input.name}' was not found on registry ${baseUrl}` } },
		}
	}

	const resolvedVersion = input.version ?? detail.latestVersion
	if (resolvedVersion === null) {
		return {
			ok: false,
			payload: {
				error: { message: `no installable version for '${input.scope}/${input.name}' (every version is non-ready)` },
			},
		}
	}

	let previews: Array<RegistryPreviewEntry>
	try {
		const list = await getPackPreviews({
			baseUrl,
			scope: input.scope,
			name: input.name,
			version: resolvedVersion,
			apiKey,
		})
		previews = list.previews
	} catch (err) {
		return {
			ok: false,
			payload: {
				error: {
					message: transportErrorMessage(
						err,
						baseUrl,
						`/v1/packs/${input.scope}/${input.name}/${resolvedVersion}/previews`,
					),
					status: err instanceof RegistryHttpError ? err.status : undefined,
				},
			},
		}
	}

	const detailed: PreviewEntryPayload[] = []
	for (const p of previews) {
		let recipePreview: RegistryRecipePreview | null
		try {
			recipePreview = await getRecipePreview({
				baseUrl,
				scope: input.scope,
				name: input.name,
				version: resolvedVersion,
				recipeId: p.recipeId,
				apiKey,
			})
		} catch (err) {
			return {
				ok: false,
				payload: {
					error: {
						message: transportErrorMessage(
							err,
							baseUrl,
							`/v1/packs/${input.scope}/${input.name}/${resolvedVersion}/previews/${p.recipeId}`,
						),
						status: err instanceof RegistryHttpError ? err.status : undefined,
					},
				},
			}
		}
		if (recipePreview === null) continue
		if (recipePreview.state === "rendered") {
			detailed.push({
				recipeId: recipePreview.recipeId,
				state: "rendered",
				files: recipePreview.files ?? [],
			})
		} else {
			detailed.push({
				recipeId: recipePreview.recipeId,
				state: "needs-llm",
				reason: recipePreview.reason ?? "recipe skipped because it requires LLM reasoning",
				files: recipePreview.files ?? [],
			})
		}
	}

	return {
		ok: true,
		payload: {
			scope: input.scope,
			name: input.name,
			version: resolvedVersion,
			registry: baseUrl,
			previews: detailed,
		},
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function transportErrorMessage(err: unknown, baseUrl: string, path: string): string {
	if (err instanceof RegistryTransportError) {
		return `registry unreachable at ${baseUrl} (${path}): ${err.message.split(":").slice(-1)[0]?.trim() ?? err.message}`
	}
	if (err instanceof RegistryHttpError) {
		return `registry ${path} on ${baseUrl} failed: HTTP ${err.status}${err.message ? `: ${err.message}` : ""}`
	}
	if (err instanceof Error) return err.message
	return String(err)
}
