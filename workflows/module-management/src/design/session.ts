import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DesignSessionState } from "./state"

// ---------------------------------------------------------------------------
// Session persistence. Reads/writes the .design-state.json file in the
// module directory. Pure wrt the state machine — this is just I/O.
// ---------------------------------------------------------------------------

export const STATE_FILE = ".design-state.json"

export function loadSession(moduleDir: string): DesignSessionState | null {
	const path = join(moduleDir, STATE_FILE)
	if (!existsSync(path)) return null
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as DesignSessionState
	} catch {
		return null
	}
}

export function saveSession(state: DesignSessionState, moduleDir: string): void {
	mkdirSync(moduleDir, { recursive: true })
	writeFileSync(join(moduleDir, STATE_FILE), JSON.stringify(state, null, 2), "utf-8")
}
