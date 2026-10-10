import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BAKA_LOCKFILE_NAME, type BakaLock, BakaLockSchema, type PackManifest, type PackPin } from "@repo/protocol"
import { RecipeError } from "./errors.js"
import type { PackRegistry } from "./registry.js"
import { compareUtf8, packContentHash } from "./tree-hash.js"

/** The pin of one pack as it stands on disk. */
export function pinPack(packRoot: string, manifest: Pick<PackManifest, "name" | "version">): PackPin {
	return { id: manifest.name, version: manifest.version, contentHash: packContentHash(packRoot) }
}

/**
 * Fail unless `pin` is exactly what `lock` records for that pack. A pack
 * the lockfile does not list is `lock-unlisted`; a different version or
 * different files is `lock-mismatch`.
 */
export function verifyPin(lock: BakaLock, pin: PackPin): void {
	const locked = lock.packs[pin.id]
	if (!locked) {
		throw new RecipeError(
			"lock-unlisted",
			`pack "${pin.id}" is not in ${BAKA_LOCKFILE_NAME}; run \`baka lock\` to add it`,
		)
	}
	if (locked.version !== pin.version) {
		throw new RecipeError(
			"lock-mismatch",
			`pack "${pin.id}" is locked at version ${locked.version} but version ${pin.version} was found`,
		)
	}
	if (locked.contentHash !== pin.contentHash) {
		throw new RecipeError(
			"lock-mismatch",
			`pack "${pin.id}" ${pin.version} differs from ${BAKA_LOCKFILE_NAME}: locked contentHash ${locked.contentHash}, found ${pin.contentHash}`,
		)
	}
}

/**
 * Build a lock from the registry's packs (all of them, or just `names`).
 * Keys are sorted so the serialized file is stable.
 */
export function createLock(registry: PackRegistry, names?: readonly string[]): BakaLock {
	const { packs } = registry.discover(false)
	const wanted = names ? new Set(names) : null
	const entries: Array<[string, { version: string; contentHash: string }]> = []
	for (const manifest of packs) {
		if (wanted && !wanted.has(manifest.name)) continue
		const root = registry.packRootFor(manifest.name)
		if (!root) continue
		entries.push([manifest.name, { version: manifest.version, contentHash: packContentHash(root) }])
	}
	entries.sort(([a], [b]) => compareUtf8(a, b))
	return { lockfileVersion: 1, packs: Object.fromEntries(entries) }
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
