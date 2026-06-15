import { existsSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"

export async function nextAppExists(state: OrchestrationState) {
	const candidates = [join(state.targetDirectory, "src", "app"), join(state.targetDirectory, "app")]
	if (candidates.some((c) => existsSync(c))) return []
	return [
		{
			severity: "error" as const,
			rule: "next-app-exists",
			message: `no App Router directory at ${candidates.join(" or ")}; run next-base.scaffold first`,
		},
	]
}
