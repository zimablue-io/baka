import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { RecipeError } from "./errors.js"

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const child of Object.values(value)) deepFreeze(child)
	}
	return value
}

/**
 * A pack's data files: every `data/<name>.json` directly under the pack
 * root, parsed and exposed as `data.<name>` (so `data/versions.json` is
 * `{{data.versions.pnpm}}` in a template and `ctx.data.versions.pnpm` in an
 * `recipe.ts`). The result is deeply frozen: read-only. Other files and
 * subdirectories in `data/` are ignored; a file that is not valid JSON, or
 * whose stem is not `[A-Za-z0-9][A-Za-z0-9_-]*`, makes the pack invalid.
 * The files are part of the pack's content hash, so a lockfile pin covers them.
 */
export function loadPackData(packRoot: string): Readonly<Record<string, unknown>> {
	const dir = join(packRoot, "data")
	const data: Record<string, unknown> = {}
	if (!existsSync(dir)) return data
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue
		const key = entry.name.slice(0, -".json".length)
		if (!KEY.test(key)) {
			throw new RecipeError(
				"pack-invalid",
				`data/${entry.name}: the file name must match ${KEY} to be exposed as data.<name>`,
			)
		}
		try {
			data[key] = JSON.parse(readFileSync(join(dir, entry.name), "utf-8"))
		} catch (err) {
			throw new RecipeError(
				"pack-invalid",
				`data/${entry.name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	return deepFreeze(data)
}
