import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BAKA_PROJECT_PATHS, bakaHomeDir } from "@repo/protocol"

export interface SlotCacheRecord {
	key: string
	slotId: string
	kind: string
	value: unknown
	model: string
	templateHash: string
	paramsHash: string
}

export function projectSlotsDir(cwd: string): string {
	return join(cwd, BAKA_PROJECT_PATHS.SLOTS)
}

export function userSlotsDir(): string {
	return join(bakaHomeDir(), "slots")
}

export function readSlotCache(cwd: string, key: string): SlotCacheRecord | null {
	const projectPath = join(projectSlotsDir(cwd), `${key}.json`)
	if (existsSync(projectPath)) {
		return JSON.parse(readFileSync(projectPath, "utf-8")) as SlotCacheRecord
	}
	const userPath = join(userSlotsDir(), `${key}.json`)
	if (existsSync(userPath)) {
		return JSON.parse(readFileSync(userPath, "utf-8")) as SlotCacheRecord
	}
	return null
}

export function writeSlotCache(cwd: string, record: SlotCacheRecord): string {
	const dir = projectSlotsDir(cwd)
	mkdirSync(dir, { recursive: true })
	const path = join(dir, `${record.key}.json`)
	writeFileSync(path, `${JSON.stringify(record, null, "\t")}\n`, "utf-8")
	return path
}
