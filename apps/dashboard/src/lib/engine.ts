export const DEFAULT_ENGINE_URL = "http://127.0.0.1:4311"

/** Where the engine is. Build-time default is the non-secret `VITE_ENGINE_URL`; the page can override it at run time. */
export function normalizeEngineUrl(raw: string | undefined | null): string {
	const trimmed = (raw ?? "").trim()
	if (!trimmed) return DEFAULT_ENGINE_URL
	try {
		const url = new URL(trimmed)
		if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_ENGINE_URL
		return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""))
	} catch {
		return DEFAULT_ENGINE_URL
	}
}

const connection = {
	url: normalizeEngineUrl(import.meta.env?.VITE_ENGINE_URL as string | undefined),
	token: "",
}

/** The bearer token is a secret: it lives only in this module's memory (and the page's session), never in a `VITE_` variable or the bundle. */
export function setEngineConnection(next: { url?: string; token?: string }): void {
	if (next.url !== undefined) connection.url = normalizeEngineUrl(next.url)
	if (next.token !== undefined) connection.token = next.token.trim()
}

export function engineUrl(): string {
	return connection.url
}

export function engineAuthHeaders(token: string): Record<string, string> {
	return token ? { authorization: `Bearer ${token}` } : {}
}

export interface EngineParam {
	name: string
	type: string
	required?: boolean
	description?: string
	enumValues?: string[]
}

export interface EngineRecipe {
	id: string
	description?: string
	params: EngineParam[]
	requiresReasoning?: boolean
	filePatterns?: string[]
}

export interface EnginePack {
	name: string
	version?: string
	description?: string
	recipes: EngineRecipe[]
}

export interface EngineSlot {
	id: string
	kind: string
	hint?: string
	file?: string
	max?: number
	item?: string
}

export interface EnginePreview {
	pack: string
	recipe: string
	description?: string
	params: EngineParam[]
	requiresReasoning?: boolean
	filePatterns?: string[]
	files: Array<{ rel: string; source: string }>
	slots: EngineSlot[]
}

interface RunResult {
	ok?: boolean
	diagnostics?: Array<{ severity: string; rule: string; message: string }>
	changeset?: Array<{ path: string; op: string; contentHash: string | null; reason?: string; content?: string }>
	outputTreeHash?: string
	slots?: Array<{ id: string; model: string; source: string }>
}

function projectQuery(project: string): string {
	const trimmed = project.trim()
	return trimmed ? `project=${encodeURIComponent(trimmed)}` : ""
}

export function defaultParamValues(params: EngineParam[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (const param of params) {
		out[param.name] = ""
	}
	return out
}

export function paramsFromFields(fields: Record<string, string>, schema: EngineParam[]): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const param of schema) {
		const raw = fields[param.name] ?? ""
		if (raw === "" && !param.required) continue
		if (param.type === "boolean") {
			out[param.name] = raw === "true" || raw === "1"
			continue
		}
		if (param.type === "number") {
			out[param.name] = Number(raw)
			continue
		}
		out[param.name] = raw
	}
	return out
}

/** The message to show for a failed call: the error document's, else a failed receipt's first error, else `fallback`. */
export function errorDetail(body: unknown, fallback: string): string {
	if (typeof body !== "object" || body === null) return fallback
	const { error, diagnostics } = body as {
		error?: { message?: unknown }
		diagnostics?: Array<{ severity?: unknown; message?: unknown }>
	}
	if (typeof error?.message === "string") return error.message
	const first = diagnostics?.find((d) => d.severity === "error")
	return typeof first?.message === "string" ? first.message : fallback
}

async function engineJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${connection.url}${path}`, {
		...init,
		headers: { ...engineAuthHeaders(connection.token), ...(init?.headers as Record<string, string> | undefined) },
	})
	if (!res.ok) {
		const status = `${init?.method ?? "GET"} ${path} ${res.status}`
		let body: unknown = null
		try {
			body = await res.json()
		} catch {
			/* not JSON: the status line says what happened */
		}
		throw new Error(errorDetail(body, status))
	}
	return (await res.json()) as T
}

export async function fetchPacks(project: string): Promise<EnginePack[]> {
	const q = projectQuery(project)
	const body = await engineJson<{ packs?: EnginePack[] }>(`/v1/packs${q ? `?${q}` : ""}`)
	return body.packs ?? []
}

export async function fetchPreview(project: string, packName: string, recipe: string): Promise<EnginePreview> {
	const parts = [`pack=${encodeURIComponent(packName)}`, `recipe=${encodeURIComponent(recipe)}`]
	const q = projectQuery(project)
	if (q) parts.push(q)
	return engineJson<EnginePreview>(`/v1/preview?${parts.join("&")}`)
}

export async function fillSlot(
	project: string,
	packName: string,
	recipe: string,
	slot: string,
	value: unknown,
	params: Record<string, unknown>,
): Promise<void> {
	await engineJson("/v1/fill", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			project: project.trim() || undefined,
			pack: packName,
			recipe,
			slot,
			value,
			params,
		}),
	})
}

export async function runNamed(
	project: string,
	packName: string,
	recipe: string,
	params: Record<string, unknown>,
): Promise<RunResult> {
	return engineJson<RunResult>("/v1/run", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			project: project.trim() || undefined,
			pack: packName,
			recipe,
			params,
			includeContent: true,
		}),
	})
}
