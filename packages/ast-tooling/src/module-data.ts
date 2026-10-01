import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ActionError } from "./errors.js"

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const child of Object.values(value)) deepFreeze(child)
	}
	return value
}

/**
 * A module's data files: every `data/<name>.json` directly under the module
 * root, parsed and exposed as `data.<name>` (so `data/versions.json` is
 * `{{data.versions.pnpm}}` in a template and `ctx.data.versions.pnpm` in an
 * `action.ts`). The result is deeply frozen: read-only. Other files and
 * subdirectories in `data/` are ignored; a file that is not valid JSON, or
 * whose stem is not `[A-Za-z0-9][A-Za-z0-9_-]*`, makes the module invalid.
 * The files are part of the module's content hash, so a lockfile pin covers them.
 */
export function loadModuleData(moduleRoot: string): Readonly<Record<string, unknown>> {
	const dir = join(moduleRoot, "data")
	const data: Record<string, unknown> = {}
	if (!existsSync(dir)) return data
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue
		const key = entry.name.slice(0, -".json".length)
		if (!KEY.test(key)) {
			throw new ActionError(
				"module-invalid",
				`data/${entry.name}: the file name must match ${KEY} to be exposed as data.<name>`,
			)
		}
		try {
			data[key] = JSON.parse(readFileSync(join(dir, entry.name), "utf-8"))
		} catch (err) {
			throw new ActionError(
				"module-invalid",
				`data/${entry.name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	return deepFreeze(data)
}
