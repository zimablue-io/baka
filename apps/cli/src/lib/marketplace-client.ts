import type { AggregateResponse, ApiCatalog, ModuleLookupResponse, VerifiedResponse } from "@baka/api/schema"

/**
 * Thin HTTP client for the baka marketplace backend.
 *
 * The base URL is resolved in this order:
 *   1. `BAKA_API_URL` env var (CI / one-off override)
 *   2. The `apiUrl` field passed in `ClientOptions`
 *   3. The built-in default (`https://api.baka.foo`)
 *
 * The default will be updated once the production domain is decided. The
 * user can override at runtime via the env var without rebuilding.
 */

const DEFAULT_API_URL = "https://api.baka.foo"

export function getMarketplaceApiUrl(): string {
	return process.env.BAKA_API_URL ?? DEFAULT_API_URL
}

export interface ClientOptions {
	apiUrl?: string
	fetch?: typeof fetch
}

async function request<T>(path: string, init: RequestInit, opts: ClientOptions = {}): Promise<T> {
	const base = opts.apiUrl ?? getMarketplaceApiUrl()
	const f = opts.fetch ?? globalThis.fetch
	const res = await f(`${base}${path}`, init)
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(
			`marketplace API ${init.method ?? "GET"} ${path} failed: HTTP ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`,
		)
	}
	return (await res.json()) as T
}

export async function getBuiltInCatalog(opts?: ClientOptions): Promise<ApiCatalog> {
	return request<ApiCatalog>("/v1/built-in", { method: "GET" }, opts)
}

export async function getVerifiedList(opts?: ClientOptions): Promise<VerifiedResponse> {
	return request<VerifiedResponse>("/v1/verified", { method: "GET" }, opts)
}

export async function lookupModule(
	name: string,
	catalogs: string[],
	opts?: ClientOptions,
): Promise<ModuleLookupResponse> {
	const params = new URLSearchParams()
	for (const url of catalogs) params.append("catalogs", url)
	const qs = params.toString()
	return request<ModuleLookupResponse>(
		`/v1/modules/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`,
		{ method: "GET" },
		opts,
	)
}

export async function aggregate(catalogs: string[], opts?: ClientOptions): Promise<AggregateResponse> {
	return request<AggregateResponse>(
		"/v1/aggregate",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ catalogs }),
		},
		opts,
	)
}
