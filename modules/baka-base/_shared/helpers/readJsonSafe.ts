import { existsSync, readFileSync } from "node:fs"

/**
 * Shared helper used by multiple actions in `baka-base`. Reads a JSON file
 * and parses it, returning `undefined` if the file does not exist or the
 * JSON is malformed. Useful for actions that need to read a previous
 * package.json (or similar) before mutating it.
 */
export function readJsonSafe<T = unknown>(path: string): T | undefined {
	if (!existsSync(path)) return undefined
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T
	} catch {
		return undefined
	}
}
