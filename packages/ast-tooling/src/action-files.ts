import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { posix } from "node:path"
import type { ActionFiles, ActionFileWrite, ActionWriteOptions, ChangesetEntry, OnExisting } from "@repo/protocol"
import { ensureDirectory, normalizeRelativePath, resolveContained } from "./contain.js"
import { ActionError } from "./errors.js"
import type { Rollback } from "./materialize.js"
import { hashBytes } from "./slots.js"
import { compareUtf8 } from "./tree-hash.js"

interface ProjectFilesOptions {
	root: string
	/** The run's policy; the default for `write`. */
	onExisting: OnExisting
	/** Keep writes in a virtual tree and leave the disk alone. */
	dryRun: boolean
	/** Dry run: bytes the templates plan to write, which the virtual tree already holds. */
	seed?: ReadonlyMap<string, Buffer>
}

export interface ProjectFiles {
	/** What the `action.ts` receives as `ctx.files`. */
	api: ActionFiles
	/** Everything needed to undo the writes made through `api` (real runs). */
	rollback(): Rollback
	/**
	 * One entry per path the action addressed through `write`/`remove`, judged
	 * against what was there when it first touched the path: `create`,
	 * `update`, `delete`, `unchanged` (identical bytes), or `skip` (other bytes
	 * left alone).
	 */
	entries(): ChangesetEntry[]
	/** `unchanged` entries for the paths the action declared with `own` that exist now. */
	ownedEntries(): ChangesetEntry[]
}

function toBytes(content: string | Uint8Array): Buffer {
	return typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content)
}

/**
 * The contained file API of an `action.ts`. In a real run each call acts on
 * the disk at once and is journalled so a failed run can be undone; in a dry
 * run the same calls act on an overlay and the disk is never touched.
 */
export function createProjectFiles(opts: ProjectFilesOptions): ProjectFiles {
	const { root, dryRun } = opts
	const overlay = new Map<string, Buffer | null>()
	const initial = new Map<string, Buffer | null>()
	const skipped = new Set<string>()
	const owned = new Set<string>()
	const journal: Rollback = { created: [], createdDirs: [], overwritten: [] }
	const journalled = new Set<string>()

	/** The bytes at `rel` right now, or null. `rel` is already normalized. */
	const current = (rel: string): Buffer | null => {
		if (dryRun) {
			if (overlay.has(rel)) return overlay.get(rel) ?? null
			const seeded = opts.seed?.get(rel)
			if (seeded) return seeded
		}
		const abs = resolveContained(root, rel)
		if (!existsSync(abs)) return null
		if (!statSync(abs).isFile()) throw new ActionError("action-failed", `"${rel}" exists and is not a regular file`)
		return readFileSync(abs)
	}

	const touch = (rel: string): Buffer | null => {
		const now = current(rel)
		if (!initial.has(rel)) initial.set(rel, now)
		return now
	}

	/** Remember how to undo the first change to `rel`: delete it if it was new, restore its bytes if not. */
	const journalFirstChange = (rel: string): void => {
		if (journalled.has(rel)) return
		journalled.add(rel)
		const before = initial.get(rel)
		if (before === null || before === undefined) journal.created.push(rel)
		else journal.overwritten.push({ path: rel, contentBase64: before.toString("base64") })
	}

	const api: ActionFiles = {
		exists(path: string): boolean {
			return current(normalizeRelativePath(path)) !== null
		},

		readText(path: string): string {
			const rel = normalizeRelativePath(path)
			const bytes = current(rel)
			if (bytes === null) throw new ActionError("action-failed", `files.readText: "${rel}" does not exist`)
			return bytes.toString("utf-8")
		},

		write(path: string, content: string | Uint8Array, options: ActionWriteOptions = {}): ActionFileWrite {
			const rel = normalizeRelativePath(path)
			const abs = resolveContained(root, rel)
			const bytes = toBytes(content)
			const policy = options.onExisting ?? opts.onExisting
			const prior = touch(rel)
			if (prior !== null && policy === "fail") {
				throw new ActionError("target-exists", `onExisting is "fail" and "${rel}" already exists`)
			}
			if (prior?.equals(bytes)) {
				skipped.delete(rel)
				return { path: rel, op: "unchanged", contentHash: hashBytes(bytes) }
			}
			if (prior !== null && policy === "skip") {
				skipped.add(rel)
				return { path: rel, op: "skip", contentHash: hashBytes(prior) }
			}
			skipped.delete(rel)
			if (dryRun) {
				overlay.set(rel, bytes)
			} else {
				journalFirstChange(rel)
				ensureDirectory(root, posix.dirname(rel), journal.createdDirs)
				writeFileSync(abs, bytes)
			}
			return { path: rel, op: prior === null ? "create" : "update", contentHash: hashBytes(bytes) }
		},

		remove(path: string): boolean {
			const rel = normalizeRelativePath(path)
			const abs = resolveContained(root, rel)
			if (touch(rel) === null) return false
			skipped.delete(rel)
			if (dryRun) {
				overlay.set(rel, null)
			} else {
				journalFirstChange(rel)
				rmSync(abs, { force: true })
			}
			return true
		},

		own(...paths: string[]): void {
			for (const path of paths) owned.add(normalizeRelativePath(path))
		},
	}

	return {
		api,
		rollback: () => ({
			created: [...journal.created],
			createdDirs: [...journal.createdDirs],
			overwritten: [...journal.overwritten],
		}),
		entries: () => {
			const entries: ChangesetEntry[] = []
			for (const [path, before] of initial) {
				const after = current(path)
				if (before === null && after === null) continue
				if (after === null) entries.push({ path, op: "delete", contentHash: null })
				else if (before === null) entries.push({ path, op: "create", contentHash: hashBytes(after) })
				else if (skipped.has(path)) {
					entries.push({ path, op: "skip", contentHash: hashBytes(after), reason: "already-exists" })
				} else if (before.equals(after)) {
					entries.push({ path, op: "unchanged", contentHash: hashBytes(after), reason: "identical" })
				} else entries.push({ path, op: "update", contentHash: hashBytes(after) })
			}
			return entries.sort((a, b) => compareUtf8(a.path, b.path))
		},
		ownedEntries: () =>
			[...owned]
				.map((path) => ({ path, bytes: current(path) }))
				.filter((o): o is { path: string; bytes: Buffer } => o.bytes !== null)
				.map(({ path, bytes }) => ({
					path,
					op: "unchanged" as const,
					contentHash: hashBytes(bytes),
					reason: "identical" as const,
				}))
				.sort((a, b) => compareUtf8(a.path, b.path)),
	}
}
