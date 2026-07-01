// `baka roles` — list every configured role with its fields.
// apiKey is masked as `<set>` (any non-empty value) or `(empty)` (none).

import { listRoles, readRoleConfig, SUPPORTED_ROLES, userConfigPath } from "@repo/agent-engine"
import { BAKA_EXIT_CODE } from "@repo/protocol"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

export function runRoles(): void {
	// Hard-fail if neither role is configured. The "missing LLM config"
	// contract is honored by `baka plan` / `baka apply` / `baka validate`,
	// but the diagnostic for "no roles configured at all" is best surfaced
	// here so the user sees a clear path to `baka init`.
	if (!readRoleConfig("worker") && !readRoleConfig("validator")) {
		die(BAKA_EXIT_CODE.USER_ERROR, "missing LLM config: no roles configured. Run `baka init` to configure.")
	}

	const configured = listRoles()
	const byRole = new Map(configured.map((r) => [r.role, r.config]))
	console.log(`user config: ${userConfigPath()}`)
	console.log("")
	for (const role of SUPPORTED_ROLES) {
		const block = byRole.get(role)
		if (block) {
			console.log(`* ${role}`)
			console.log(`    baseUrl:   ${block.baseUrl}`)
			console.log(`    model:     ${block.model}`)
			console.log(`    apiKey:    ${block.apiKey ? "<set>" : "(empty)"}`)
			if (block.temperature !== undefined) console.log(`    temp:      ${block.temperature}`)
			if (block.maxTokens !== undefined) console.log(`    maxTokens: ${block.maxTokens}`)
			if (block.timeoutMs !== undefined) console.log(`    timeoutMs: ${block.timeoutMs}`)
		} else {
			console.log(`  ${role}  (not configured)`)
		}
	}
	console.log("")
}
