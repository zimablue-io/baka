export const ENGINE_URL = "http://127.0.0.1:4311"

export interface EngineParam {
	name: string
	type: string
	required?: boolean
	description?: string
	enumValues?: string[]
}

export interface EngineAction {
	id: string
	description?: string
	params: EngineParam[]
	requiresReasoning?: boolean
	filePatterns?: string[]
}

export interface EngineModule {
	name: string
	version?: string
	description?: string
	actions: EngineAction[]
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
	module: string
	action: string
	description?: string
	params: EngineParam[]
	requiresReasoning?: boolean
	filePatterns?: string[]
	files: Array<{ rel: string; source: string }>
	slots: EngineSlot[]
}

interface RunResult {
	ok?: boolean
	error?: string
	tree?: Record<string, string>
	slots?: Array<{ id: string; kind: string; cached: boolean; source: string }>
	written?: string[]
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

async function engineJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${ENGINE_URL}${path}`, init)
	if (!res.ok) {
		let detail = `${init?.method ?? "GET"} ${path} ${res.status}`
		try {
			const body = (await res.json()) as { error?: string }
			if (body.error) detail = body.error
		} catch {
			/* use status */
		}
		throw new Error(detail)
	}
	return (await res.json()) as T
}

export async function fetchModules(project: string): Promise<EngineModule[]> {
	const q = projectQuery(project)
	const body = await engineJson<{ modules?: EngineModule[] }>(`/v1/modules${q ? `?${q}` : ""}`)
	return body.modules ?? []
}

export async function fetchPreview(project: string, moduleName: string, action: string): Promise<EnginePreview> {
	const parts = [`module=${encodeURIComponent(moduleName)}`, `action=${encodeURIComponent(action)}`]
	const q = projectQuery(project)
	if (q) parts.push(q)
	return engineJson<EnginePreview>(`/v1/preview?${parts.join("&")}`)
}

export async function fillSlot(
	project: string,
	moduleName: string,
	action: string,
	slot: string,
	value: unknown,
	params: Record<string, unknown>,
): Promise<void> {
	await engineJson("/v1/fill", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			project: project.trim() || undefined,
			module: moduleName,
			action,
			slot,
			value,
			params,
		}),
	})
}

export async function runNamed(
	project: string,
	moduleName: string,
	action: string,
	params: Record<string, unknown>,
): Promise<RunResult> {
	return engineJson<RunResult>("/v1/run", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			project: project.trim() || undefined,
			module: moduleName,
			action,
			params,
		}),
	})
}
