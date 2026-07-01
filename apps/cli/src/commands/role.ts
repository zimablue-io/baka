// `baka role <worker|validator>` — edit one role.
//
// Non-interactive flags: `--field <name> --value <value>`. Supported fields:
// baseUrl, model, apiKey, temperature, maxTokens, timeoutMs. The apiKey
// field accepts plain text; the values are NOT echoed back by `baka role
// show` (which masks apiKey as `<set>`).

import { input, password } from "@inquirer/prompts"
import {
	isRoleName,
	type RoleConfig,
	readRoleConfig,
	SUPPORTED_ROLES,
	userConfigPath,
	writeRoleConfig,
} from "@repo/agent-engine"
import { BAKA_EXIT_CODE } from "@repo/protocol"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

const EDITABLE_FIELDS = ["baseUrl", "model", "apiKey", "temperature", "maxTokens", "timeoutMs"] as const
type EditableField = (typeof EDITABLE_FIELDS)[number]
function isEditableField(value: string): value is EditableField {
	return (EDITABLE_FIELDS as readonly string[]).includes(value)
}

function parseNumber(field: EditableField, value: string): number {
	const n = Number(value)
	if (Number.isNaN(n)) die(BAKA_EXIT_CODE.USER_ERROR, `${field} must be a number; got '${value}'`)
	return n
}

function setField(block: RoleConfig, field: EditableField, value: string): RoleConfig {
	switch (field) {
		case "baseUrl":
		case "model":
		case "apiKey":
			return { ...block, [field]: value }
		case "temperature":
		case "maxTokens":
		case "timeoutMs":
			return { ...block, [field]: parseNumber(field, value) }
	}
}

export interface RunRoleOpts {
	field?: string
	value?: string
}

export async function runRole(role: string, opts: RunRoleOpts): Promise<void> {
	if (!isRoleName(role)) {
		const known = SUPPORTED_ROLES.join(", ")
		die(BAKA_EXIT_CODE.USER_ERROR, `unknown role "${role}". Known roles: ${known}`)
	}
	const existing = readRoleConfig(role)
	if (!existing) {
		die(BAKA_EXIT_CODE.USER_ERROR, `role "${role}" is not configured. Run \`baka init\` to set it up.`)
	}

	if (opts.field) {
		if (!opts.value && opts.field !== "apiKey") {
			die(BAKA_EXIT_CODE.USER_ERROR, `--value is required when --field is set`)
		}
		if (!isEditableField(opts.field)) {
			die(BAKA_EXIT_CODE.USER_ERROR, `unknown field "${opts.field}". Editable: ${EDITABLE_FIELDS.join(", ")}`)
		}
		const updated = setField(existing, opts.field, opts.value ?? "")
		writeRoleConfig(role, updated)
		console.log(`set ${role}.${opts.field}`)
		return
	}

	// Interactive edit: prompt for every field, defaulting to current values.
	const baseUrl = await input({
		message: `${role} — base URL:`,
		default: existing.baseUrl,
	})
	const model = await input({
		message: `${role} — model id:`,
		default: existing.model,
	})
	const apiKey = await password({
		message: `${role} — API key (blank to keep current)`,
		mask: "*",
	})
	const temperatureStr = await input({
		message: `${role} — temperature:`,
		default: String(existing.temperature ?? 0),
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})
	const maxTokensStr = await input({
		message: `${role} — max tokens:`,
		default: String(existing.maxTokens ?? 8192),
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})
	const timeoutStr = await input({
		message: `${role} — timeout (ms):`,
		default: String(existing.timeoutMs ?? 120_000),
		validate: (v) => (!Number.isNaN(Number(v)) ? true : "must be a number"),
	})

	const updated: RoleConfig = {
		baseUrl,
		model,
		apiKey: apiKey === "" ? existing.apiKey : apiKey,
		temperature: Number(temperatureStr),
		maxTokens: Number(maxTokensStr),
		timeoutMs: Number(timeoutStr),
	}
	writeRoleConfig(role, updated)
	console.log(`updated ${role} at ${userConfigPath()}`)
}

export function runRoleShow(role: string): void {
	if (!isRoleName(role)) {
		const known = SUPPORTED_ROLES.join(", ")
		die(BAKA_EXIT_CODE.USER_ERROR, `unknown role "${role}". Known roles: ${known}`)
	}
	const block = readRoleConfig(role)
	if (!block) {
		die(BAKA_EXIT_CODE.USER_ERROR, `role "${role}" is not configured. Run \`baka init\` to set it up.`)
	}
	console.log(`role: ${role}`)
	console.log(`  baseUrl:   ${block.baseUrl}`)
	console.log(`  model:     ${block.model}`)
	console.log(`  apiKey:    ${block.apiKey ? "<set>" : "(empty)"}`)
	if (block.temperature !== undefined) console.log(`  temp:      ${block.temperature}`)
	if (block.maxTokens !== undefined) console.log(`  maxTokens: ${block.maxTokens}`)
	if (block.timeoutMs !== undefined) console.log(`  timeoutMs: ${block.timeoutMs}`)
}

export function runRolePath(): void {
	console.log(userConfigPath())
}
