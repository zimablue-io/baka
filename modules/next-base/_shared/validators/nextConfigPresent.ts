import { existsSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"

export async function nextConfigPresent(state: OrchestrationState) {
	const path = join(state.targetDirectory, "next.config.ts")
	if (existsSync(path)) return []
	return [{ severity: "warning" as const, rule: "next-config-present", message: `next.config.ts not found at ${path}` }]
}
