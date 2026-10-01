import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BAKA_LOCKFILE_NAME, type BakaLock, BakaLockSchema, type ModuleManifest, type ModulePin } from "@repo/protocol"
import { ActionError } from "./errors.js"
import type { ModuleRegistry } from "./registry.js"
import { compareUtf8, moduleContentHash } from "./tree-hash.js"

/** The pin of one module as it stands on disk. */
export function pinModule(moduleRoot: string, manifest: Pick<ModuleManifest, "name" | "version">): ModulePin {
	return { id: manifest.name, version: manifest.version, contentHash: moduleContentHash(moduleRoot) }
}

/**
 * Fail unless `pin` is exactly what `lock` records for that module. A module
 * the lockfile does not list is `lock-unlisted`; a different version or
 * different files is `lock-mismatch`.
 */
export function verifyPin(lock: BakaLock, pin: ModulePin): void {
	const locked = lock.modules[pin.id]
	if (!locked) {
		throw new ActionError(
			"lock-unlisted",
			`module "${pin.id}" is not in ${BAKA_LOCKFILE_NAME}; run \`baka lock\` to add it`,
		)
	}
	if (locked.version !== pin.version) {
		throw new ActionError(
			"lock-mismatch",
			`module "${pin.id}" is locked at version ${locked.version} but version ${pin.version} was found`,
		)
	}
	if (locked.contentHash !== pin.contentHash) {
		throw new ActionError(
			"lock-mismatch",
			`module "${pin.id}" ${pin.version} differs from ${BAKA_LOCKFILE_NAME}: locked contentHash ${locked.contentHash}, found ${pin.contentHash}`,
		)
	}
}

/**
 * Build a lock from the registry's modules (all of them, or just `names`).
 * Keys are sorted so the serialized file is stable.
 */
export function createLock(registry: ModuleRegistry, names?: readonly string[]): BakaLock {
	const { modules } = registry.discover(false)
	const wanted = names ? new Set(names) : null
	const entries: Array<[string, { version: string; contentHash: string }]> = []
	for (const manifest of modules) {
		if (wanted && !wanted.has(manifest.name)) continue
		const root = registry.moduleRootFor(manifest.name)
		if (!root) continue
		entries.push([manifest.name, { version: manifest.version, contentHash: moduleContentHash(root) }])
	}
	entries.sort(([a], [b]) => compareUtf8(a, b))
	return { lockfileVersion: 1, modules: Object.fromEntries(entries) }
}

/** `<root>/baka.lock.json`. */
export function lockfilePath(root: string): string {
	return join(root, BAKA_LOCKFILE_NAME)
}

/** Read and validate a lockfile; null when the file does not exist. Throws on a malformed one. */
export function readLockfile(root: string): BakaLock | null {
	const path = lockfilePath(root)
	if (!existsSync(path)) return null
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"))
	} catch (err) {
		throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
	}
	const parsed = BakaLockSchema.safeParse(raw)
	if (!parsed.success) {
		throw new Error(
			`${path} is not a valid ${BAKA_LOCKFILE_NAME}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		)
	}
	return parsed.data
}

/** Write the lockfile as pretty-printed JSON with a trailing newline. Returns its path. */
export function writeLockfile(root: string, lock: BakaLock): string {
	const path = lockfilePath(root)
	writeFileSync(path, `${JSON.stringify(lock, null, "\t")}\n`, "utf-8")
	return path
}
