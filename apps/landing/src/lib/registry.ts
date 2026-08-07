import {
	RegistryActionPreviewSchema,
	RegistryCatalogResponseSchema,
	RegistryModuleDetailSchema,
	RegistryPreviewListResponseSchema,
	RegistryVersionDetailSchema,
} from "@repo/protocol"
import type { z } from "zod"

/**
 * Client-side registry fetcher for the landing app.
 *
 * The landing renders live data from the baka registry (architecture
 * §5.3). All fetches go through `fetch()` against `VITE_REGISTRY_URL`
 * (default `http://localhost:4300`); responses are validated against
 * the protocol schemas from `@repo/protocol` so a registry change
 * surfaces as a typed parse error rather than a silent UI drift.
 *
 * Every error path names the URL the client tried so the UI can render
 * an honest "registry unreachable at <url>" message (VAL-WEB-007),
 * not a generic "something went wrong". Distinguishing network / HTTP /
 * parse failures lets the UI branch (a 404 is "module removed", a
 * network failure is "registry down").
 */

/**
 * The base URL the landing app reads from.
 *
 * Read from `VITE_REGISTRY_URL` at module load (Vite exposes
 * `import.meta.env.VITE_*` at build time). When unset / empty the
 * dev default is `http://localhost:4300` — the same value documented
 * for the CLI and MCP clients, so the landing, CLI, and MCP all
 * point at the same registry out of the box.
 *
 * Exposed via `resolveBaseUrl()` so tests can re-evaluate it after
 * stubbing the env. The exported `REGISTRY_BASE_URL` is the
 * module-load value, used by callers that want a stable reference.
 */
export const DEFAULT_REGISTRY_BASE_URL = "http://localhost:4300"

export function resolveBaseUrl(): string {
	const envValue = (import.meta.env.VITE_REGISTRY_URL as string | undefined) ?? ""
	const trimmed = envValue.trim()
	if (trimmed.length === 0) return DEFAULT_REGISTRY_BASE_URL
	return trimmed
}

export const REGISTRY_BASE_URL: string = resolveBaseUrl()

export type RegistryErrorCode = "network" | "http" | "parse" | "not-found"

/**
 * Error thrown by the registry client. The UI uses `code` to branch
 * (a not-found on `getModuleDetail` is "module removed", while a
 * network error is "registry unreachable"); `url` and `status`
 * surface the exact cause so the message can be specific.
 */
export class RegistryError extends Error {
	readonly code: RegistryErrorCode
	readonly url: string
	readonly status: number | undefined

	constructor(message: string, code: RegistryErrorCode, url: string, status?: number) {
		super(message)
		this.name = "RegistryError"
		this.code = code
		this.url = url
		this.status = status
	}
}

/**
 * Fetches JSON from the registry and parses it through the given zod
 * schema. Distinguishes three failure classes:
 *   - network: the `fetch()` itself threw (DNS, connection refused, abort)
 *   - http / not-found: a non-2xx response arrived
 *   - parse: the body was JSON but did not match the expected schema
 *
 * Every error message names the URL the client tried.
 */
async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
	let response: Response
	try {
		response = await fetch(url, {
			headers: { accept: "application/json" },
		})
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		throw new RegistryError(`registry unreachable at ${url}: ${reason}`, "network", url)
	}
	if (!response.ok) {
		const code: RegistryErrorCode = response.status === 404 ? "not-found" : "http"
		throw new RegistryError(`registry returned HTTP ${response.status} at ${url}`, code, url, response.status)
	}
	let body: unknown
	try {
		body = await response.json()
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		throw new RegistryError(`registry returned invalid JSON at ${url}: ${reason}`, "parse", url)
	}
	const parsed = schema.safeParse(body)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		const reason = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : parsed.error.message
		throw new RegistryError(`registry response did not match expected schema at ${url}: ${reason}`, "parse", url)
	}
	return parsed.data as T
}

/**
 * Fetches `GET /v1/modules` (the catalog list) and returns the parsed
 * module entries. The registry seeds this from
 * `BUILT_IN_CATALOG` in `@repo/protocol` plus any community
 * publishes. Returns an empty array when the registry is reachable
 * but has no modules (VAL-WEB-008).
 */
export async function getCatalog(
	baseUrl: string = REGISTRY_BASE_URL,
): Promise<z.infer<typeof RegistryCatalogResponseSchema>["modules"]> {
	const parsed = await fetchJson(`${baseUrl}/v1/modules`, RegistryCatalogResponseSchema)
	return parsed.modules
}

/**
 * Fetches `GET /v1/modules/:scope/:name` and returns the parsed
 * module detail. Throws a `not-found` `RegistryError` when the module
 * does not exist or the caller is not an org member (visibility
 * hides existence — uniform 404 envelope).
 */
export async function getModuleDetail(
	scope: string,
	name: string,
	baseUrl: string = REGISTRY_BASE_URL,
): Promise<z.infer<typeof RegistryModuleDetailSchema>> {
	return fetchJson(
		`${baseUrl}/v1/modules/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
		RegistryModuleDetailSchema,
	)
}

/**
 * Fetches `GET /v1/modules/:scope/:name/:version` and returns the
 * parsed version detail (manifest, screening, artifacts).
 */
export async function getVersionDetail(
	scope: string,
	name: string,
	version: string,
	baseUrl: string = REGISTRY_BASE_URL,
): Promise<z.infer<typeof RegistryVersionDetailSchema>> {
	return fetchJson(
		`${baseUrl}/v1/modules/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
		RegistryVersionDetailSchema,
	)
}

/**
 * Fetches `GET /v1/modules/:scope/:name/:version/previews` and
 * returns the per-action preview summary list (action id, state,
 * file metadata). The landing app uses this to decide which
 * actions have rendered previews vs needs-llm records vs no
 * record at all (VAL-WEB-013: explicit empty state for missing
 * previews).
 */
export async function getPreviewList(
	scope: string,
	name: string,
	version: string,
	baseUrl: string = REGISTRY_BASE_URL,
): Promise<z.infer<typeof RegistryPreviewListResponseSchema>> {
	return fetchJson(
		`${baseUrl}/v1/modules/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/previews`,
		RegistryPreviewListResponseSchema,
	)
}

/**
 * Fetches `GET /v1/modules/:scope/:name/:version/previews/:actionId`
 * and returns the per-action preview payload (full file contents
 * for rendered state; reason + optional sentinel-rendered files
 * for needs-llm). 404 surfaces as a `not-found` RegistryError so
 * the UI can render the explicit "no preview record" state without
 * distinguishing it from a missing version (VAL-WEB-013).
 */
export async function getActionPreview(
	scope: string,
	name: string,
	version: string,
	actionId: string,
	baseUrl: string = REGISTRY_BASE_URL,
): Promise<z.infer<typeof RegistryActionPreviewSchema>> {
	return fetchJson(
		`${baseUrl}/v1/modules/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/previews/${encodeURIComponent(actionId)}`,
		RegistryActionPreviewSchema,
	)
}
