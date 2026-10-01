import { type ModuleActionParam, paramsToZod } from "./schemas"

type Params = Record<string, unknown>

/**
 * Flags and form fields arrive as text. For each declared scalar, turn a
 * numeric string into a number and `"true"`/`"false"` into a boolean; leave
 * every other value for the validator to judge. Recurses into object params.
 */
function coerceParams(specs: readonly ModuleActionParam[], raw: Params): Params {
	const out: Params = { ...raw }
	for (const spec of specs) {
		const value = out[spec.name]
		if (spec.type === "number" && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
			out[spec.name] = Number(value)
		} else if (spec.type === "boolean" && (value === "true" || value === "false")) {
			out[spec.name] = value === "true"
		} else if (spec.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
			out[spec.name] = coerceParams(spec.properties ?? [], value as Params)
		}
	}
	return out
}

export type NormalizedParams = { ok: true; params: Params } | { ok: false; message: string }

/**
 * Check raw action params against the declared param specs and return the
 * params the action will see: scalars coerced from text, defaults applied.
 * Undeclared params and wrongly typed values are rejected with one message
 * that names every offending path.
 */
export function normalizeParams(specs: readonly ModuleActionParam[], raw: Params): NormalizedParams {
	const parsed = paramsToZod(specs).safeParse(coerceParams(specs, raw))
	if (parsed.success) return { ok: true, params: parsed.data }
	const message = parsed.error.issues
		.map((issue) => `${issue.path.length ? issue.path.join(".") : "params"}: ${issue.message}`)
		.join("; ")
	return { ok: false, message }
}
