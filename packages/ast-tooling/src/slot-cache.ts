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

/**
 * Read a cache record from `<cwd>/.baka/slots`. With `userFallback` a miss
 * also consults `${BAKA_HOME:-$HOME/.baka}/slots`; without it the user
 * directory is never touched.
 */
export function readSlotCache(cwd: string, key: string, userFallback = false): SlotCacheRecord | null {
	const projectPath = join(projectSlotsDir(cwd), `${key}.json`)
	if (existsSync(projectPath)) {
		return JSON.parse(readFileSync(projectPath, "utf-8")) as SlotCacheRecord
	}
	if (!userFallback) return null
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

/**
 * Where slot fills are cached between runs. The default is the on-disk
 * project cache; a caller that must not touch the disk injects a memory
 * store.
 */
export interface SlotStore {
	read(key: string): SlotCacheRecord | null
	write(record: SlotCacheRecord): void
}

/**
 * The on-disk store: `<cwd>/.baka/slots/<key>.json`. `userFallback` adds the
 * user-level `${BAKA_HOME:-$HOME/.baka}/slots` as a read-only second tier; it
 * is off unless the caller asks, so embedding code never reads user state by
 * accident.
 */
export function createDiskSlotStore(cwd: string, options: { userFallback?: boolean } = {}): SlotStore {
	return {
		read: (key) => readSlotCache(cwd, key, options.userFallback === true),
		write: (record) => {
			writeSlotCache(cwd, record)
		},
	}
}

/** A store that lives in process memory and never touches the disk. */
export function createMemorySlotStore(initial: readonly SlotCacheRecord[] = []): SlotStore {
	const records = new Map(initial.map((r) => [r.key, r]))
	return {
		read: (key) => records.get(key) ?? null,
		write: (record) => {
			records.set(record.key, record)
		},
	}
}
