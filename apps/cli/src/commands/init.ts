// `baka init` — interactive first-time setup.
//
// Writes BOTH role blocks (worker + validator) into `~/.baka/config.json`.
// If config already exists with both roles, prompts for an overwrite
// (full re-init) vs update-one-role (edit a single field). The orchestrator
// is intentionally NOT configurable here; the user-facing surface is the
// two roles.

import { confirm, input, password } from "@inquirer/prompts"
import {
	listRoles,
	type RoleConfig,
	type RoleName,
	readRoleConfig,
	userConfigPath,
	writeRoleConfig,
} from "@repo/agent-engine"
import { BAKA_EXIT_CODE } from "@repo/protocol"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

const DEFAULT_BASE_URL = "http://localhost:8080"
const DEFAULT_MODEL = "gemma4:e4b-it"

async function promptForRole(role: RoleName): Promise<RoleConfig> {
	const existing = readRoleConfig(role)

	const baseUrl = await input({
		message: `${role} — OpenAI-compatible base URL:`,
		default: existing?.baseUrl ?? DEFAULT_BASE_URL,
		validate: (v) => (v.trim() === "" ? "required" : true),
	})

	const model = await input({
		message: `${role} — model id:`,
		default: existing?.model ?? DEFAULT_MODEL,
		validate: (v) => (v.trim() === "" ? "required" : true),
	})

	const apiKey = await password({
		message: `${role} — API key (blank = "none" for local servers; stored inline in ${userConfigPath()})`,
		mask: "*",
	})

	const temperatureStr = await input({
		message: `${role} — temperature (0.0 = deterministic):`,
		default: String(existing?.temperature ?? (role === "worker" ? 1 : 0.2)),
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})
	const maxTokensStr = await input({
		message: `${role} — max tokens per response:`,
		default: String(existing?.maxTokens ?? (role === "worker" ? 8192 : 4096)),
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})
	const timeoutStr = await input({
		message: `${role} — request timeout (ms):`,
		default: String(existing?.timeoutMs ?? (role === "worker" ? 120_000 : 60_000)),
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})

	return {
		baseUrl,
		model,
		apiKey: apiKey === "" ? (existing?.apiKey ?? "none") : apiKey,
		temperature: Number(temperatureStr),
		maxTokens: Number(maxTokensStr),
		timeoutMs: Number(timeoutStr),
	}
}

export async function runInit(): Promise<void> {
	const existing = listRoles()
	if (existing.length > 0) {
		const overwrite = await confirm({
			message: `Found ${existing.length} role(s) configured. Re-prompt for ALL fields? (Choose "no" to add or edit a single role.)`,
			default: false,
		})
		if (overwrite) {
			const worker = await promptForRole("worker")
			writeRoleConfig("worker", worker)
			const validator = await promptForRole("validator")
			writeRoleConfig("validator", validator)
			console.log("")
			console.log(`  baka: re-initialized both roles at ${userConfigPath()}`)
			console.log("")
			return
		}

		// Update-one-role path
		const missing = (["worker", "validator"] as RoleName[]).filter((r) => !readRoleConfig(r))
		if (missing.length === 0) {
			console.log("init: no changes made.")
			return
		}
		for (const role of missing) {
			const block = await promptForRole(role)
			writeRoleConfig(role, block)
		}
		console.log("")
		console.log(`  baka: configured ${missing.join(", ")} at ${userConfigPath()}`)
		console.log("")
		return
	}

	const worker = await promptForRole("worker")
	writeRoleConfig("worker", worker)
	const validator = await promptForRole("validator")
	writeRoleConfig("validator", validator)

	console.log("")
	console.log(`  baka: configured both roles at ${userConfigPath()}`)
	console.log("")
}

if (process.argv[1]?.endsWith("init.ts")) {
	runInit().catch((err) => {
		const message = err instanceof Error ? err.message : String(err)
		if (message.includes("User force closed")) return
		die(BAKA_EXIT_CODE.USER_ERROR, message)
	})
}
