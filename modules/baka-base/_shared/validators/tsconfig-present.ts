import { existsSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"

export async function tsconfigPresent(state: OrchestrationState) {
	const path = join(state.targetDirectory, "tsconfig.json")
	if (!existsSync(path)) {
		return [{ severity: "warning" as const, rule: "tsconfig-present", message: `tsconfig.json not found at ${path}` }]
	}
	return []
}
