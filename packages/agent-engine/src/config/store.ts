import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BAKA_USER_DIR } from "@repo/protocol"

// ---------------------------------------------------------------------------
// User config (single file at ~/.baka/config.json).
//
// The shape is role-keyed: each top-level key is a role name the engine
// consumes ("worker", "validator"). apiKey lives inline in the role's
// block. The orchestrator does NOT configure models; the user does at
// init time and can edit any field via `baka role <name>`. There is no
// provider alias, no active marker, no project-tree merge.
// ---------------------------------------------------------------------------

export const SUPPORTED_ROLES = ["worker", "validator"] as const
export type RoleName = (typeof SUPPORTED_ROLES)[number]

export interface RoleConfig {
	baseUrl: string
	model: string
	apiKey: string
	temperature?: number
	maxTokens?: number
	timeoutMs?: number
}

export type UserConfigShape = Partial<Record<RoleName, RoleConfig>>

function configFilePath(): string {
	return join(homedir(), `.${BAKA_USER_DIR}`, "config.json")
}

function readConfigFile(): UserConfigShape {
	const path = configFilePath()
	if (!existsSync(path)) return {}
	const text = readFileSync(path, "utf-8")
	const trimmed = text.trim()
	if (trimmed === "") return {}
	try {
		return JSON.parse(trimmed) as UserConfigShape
	} catch {
		throw new Error(`user config at ${path} is corrupt; run \`baka init\` to repair.`)
	}
}

function writeConfigFile(cfg: UserConfigShape): void {
	const path = configFilePath()
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(cfg, null, 2), "utf-8")
}

// ---------------------------------------------------------------------------
// Role-aware CRUD
// ---------------------------------------------------------------------------

export function isRoleName(value: string): value is RoleName {
	return (SUPPORTED_ROLES as readonly string[]).includes(value)
}

/**
 * Reads the block for one role. Returns `undefined` when the role has not
 * been configured. The result is the raw block as stored on disk; callers
 * apply overrides and validation themselves.
 */
export function readRoleConfig(role: RoleName): RoleConfig | undefined {
	const cfg = readConfigFile()
	if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) return undefined
	return cfg[role]
}

/**
 * Writes the block for one role, preserving the other roles' blocks
 * unchanged. Pass `undefined` to remove the role's block entirely.
 */
export function writeRoleConfig(role: RoleName, block: RoleConfig | undefined): void {
	const cfg = readConfigFile()
	const safe = cfg === null || typeof cfg !== "object" || Array.isArray(cfg) ? {} : cfg
	if (block === undefined) {
		delete safe[role]
	} else {
		safe[role] = block
	}
	writeConfigFile(safe)
}

export function listRoles(): Array<{ role: RoleName; config: RoleConfig }> {
	const cfg = readConfigFile()
	if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) return []
	const out: Array<{ role: RoleName; config: RoleConfig }> = []
	for (const role of SUPPORTED_ROLES) {
		const block = cfg[role]
		if (block) out.push({ role, config: block })
	}
	return out
}

export function userConfigPath(): string {
	return configFilePath()
}
