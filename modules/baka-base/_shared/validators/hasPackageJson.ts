import { existsSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"

export async function hasPackageJson(state: OrchestrationState) {
	const path = join(state.targetDirectory, "package.json")
	if (!existsSync(path)) {
		return [{ severity: "error" as const, rule: "has-package-json", message: `package.json not found at ${path}` }]
	}
	return []
}
