import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { posix } from "node:path"
import type { ChangesetEntry, OnExisting, RecipeFiles, RecipeFileWrite, RecipeWriteOptions } from "@repo/protocol"
import { ensureDirectory, normalizeRelativePath, resolveContained } from "./contain.js"
import { RecipeError } from "./errors.js"
import { formatMode, type Rollback } from "./materialize.js"
import { hashBytes } from "./slots.js"
import { compareUtf8 } from "./tree-hash.js"

interface ProjectFilesOptions {
	root: string
	/** The run's policy; the default for `write`. */
	onExisting: OnExisting
	/** Keep writes in a virtual tree and leave the disk alone. */
	dryRun: boolean
	/** Dry run: what the templates plan to write, which the virtual tree already holds. */
	seed?: ReadonlyMap<string, { bytes: Buffer; mode?: string }>
}

export interface ProjectFiles {
	/** What the `recipe.ts` receives as `ctx.files`. */
	api: RecipeFiles
	/** Everything needed to undo the writes made through `api` (real runs). */
	rollback(): Rollback
	/**
	 * One entry per path the recipe addressed through `write`/`remove`, judged
	 * against what was there when it first touched the path: `create`,
	 * `update`, `delete`, `unchanged` (identical bytes), or `skip` (other bytes
	 * left alone).
	 */
	entries(): ChangesetEntry[]
	/** `unchanged` entries for the paths the recipe declared with `own` that exist now. */
	ownedEntries(): ChangesetEntry[]
}

function normalizeMode(mode: string): string {
	if (!/^[0-7]{3,4}$/.test(mode) || (Number.parseInt(mode, 8) & 0o7000) !== 0) {
		throw new RecipeError(
			"recipe-failed",
			`files.write: mode "${mode}" must be three or four octal digits without setuid, setgid, or sticky bits`,
		)
	}
	return mode.padStart(4, "0")
}

function toBytes(content: string | Uint8Array): Buffer {
	return typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content)
}

/**
 * The contained file API of a `recipe.ts`. In a real run each call acts on
 * the disk at once and is journalled so a failed run can be undone; in a dry
 * run the same calls act on an overlay and the disk is never touched.
 */
export function createProjectFiles(opts: ProjectFilesOptions): ProjectFiles {
	const { root, dryRun } = opts
	const overlay = new Map<string, { bytes: Buffer; mode?: string } | null>()
	const initial = new Map<string, Buffer | null>()
	const initialMode = new Map<string, string | undefined>()
	const declared = new Map<string, string>()
	const skipped = new Set<string>()
	const owned = new Set<string>()
	const journal: Rollback = { created: [], createdDirs: [], overwritten: [] }
	const journalled = new Set<string>()

	/** The file at `rel` right now (bytes, and mode where known), or null. `rel` is already normalized. */
	const currentFile = (rel: string): { bytes: Buffer; mode?: string } | null => {
		if (dryRun) {
			if (overlay.has(rel)) return overlay.get(rel) ?? null
			const seeded = opts.seed?.get(rel)
			if (seeded) return seeded
		}
		const abs = resolveContained(root, rel)
		if (!existsSync(abs)) return null
		const stat = statSync(abs)
		if (!stat.isFile()) throw new RecipeError("recipe-failed", `"${rel}" exists and is not a regular file`)
		return { bytes: readFileSync(abs), mode: formatMode(stat.mode) }
	}
	const current = (rel: string): Buffer | null => currentFile(rel)?.bytes ?? null

	const touch = (rel: string): Buffer | null => {
		const now = currentFile(rel)
		if (!initial.has(rel)) {
			initial.set(rel, now?.bytes ?? null)
			initialMode.set(rel, now?.mode)
		}
		return now?.bytes ?? null
	}

	/** Remember how to undo the first change to `rel`: delete it if it was new, restore its bytes if not. */
	const journalFirstChange = (rel: string, recordMode: boolean): void => {
		if (journalled.has(rel)) return
		journalled.add(rel)
		const before = initial.get(rel)
		if (before === null || before === undefined) journal.created.push(rel)
		else {
			const mode = recordMode ? initialMode.get(rel) : undefined
			journal.overwritten.push({ path: rel, contentBase64: before.toString("base64"), ...(mode ? { mode } : {}) })
		}
	}

	const api: RecipeFiles = {
		exists(path: string): boolean {
			return current(normalizeRelativePath(path)) !== null
		},

		readText(path: string): string {
			const rel = normalizeRelativePath(path)
			const bytes = current(rel)
			if (bytes === null) throw new RecipeError("recipe-failed", `files.readText: "${rel}" does not exist`)
			return bytes.toString("utf-8")
		},

		write(path: string, content: string | Uint8Array, options: RecipeWriteOptions = {}): RecipeFileWrite {
			const rel = normalizeRelativePath(path)
			const abs = resolveContained(root, rel)
			const bytes = toBytes(content)
			const mode = options.mode === undefined ? undefined : normalizeMode(options.mode)
			const policy = options.onExisting ?? opts.onExisting
			const prior = touch(rel)
			const priorMode = currentFile(rel)?.mode
			if (prior !== null && policy === "fail") {
				throw new RecipeError("target-exists", `onExisting is "fail" and "${rel}" already exists`)
			}
			if (mode) declared.set(rel, mode)
			const withMode = mode ? { mode } : {}
			if (prior?.equals(bytes) && (!mode || priorMode === mode)) {
				skipped.delete(rel)
				return { path: rel, op: "unchanged", contentHash: hashBytes(bytes), ...withMode }
			}
			if (prior !== null && policy === "skip") {
				skipped.add(rel)
				return {
					path: rel,
					op: "skip",
					contentHash: hashBytes(prior),
					...(mode && priorMode ? { mode: priorMode } : {}),
				}
			}
			skipped.delete(rel)
			if (dryRun) {
				overlay.set(rel, { bytes, mode })
			} else {
				journalFirstChange(rel, mode !== undefined)
				ensureDirectory(root, posix.dirname(rel), journal.createdDirs)
				writeFileSync(abs, bytes)
				if (mode) chmodSync(abs, Number.parseInt(mode, 8))
			}
			return { path: rel, op: prior === null ? "create" : "update", contentHash: hashBytes(bytes), ...withMode }
		},

		remove(path: string): boolean {
			const rel = normalizeRelativePath(path)
			const abs = resolveContained(root, rel)
			if (touch(rel) === null) return false
			skipped.delete(rel)
			if (dryRun) {
				overlay.set(rel, null)
			} else {
				journalFirstChange(rel, true)
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
				const file = currentFile(path)
				const after = file?.bytes ?? null
				if (before === null && after === null) continue
				if (after === null) {
					entries.push({ path, op: "delete", contentHash: null })
					continue
				}
				const contentHash = hashBytes(after)
				const mode = declared.get(path)
				if (before === null) {
					entries.push({ path, op: "create", contentHash, ...(mode ? { mode } : {}) })
				} else if (skipped.has(path)) {
					entries.push({
						path,
						op: "skip",
						contentHash,
						reason: "already-exists",
						...(mode && file?.mode ? { mode: file.mode } : {}),
					})
				} else if (before.equals(after) && initialMode.get(path) === file?.mode) {
					entries.push({ path, op: "unchanged", contentHash, reason: "identical", ...(mode ? { mode } : {}) })
				} else {
					entries.push({ path, op: "update", contentHash, ...(mode ? { mode } : {}) })
				}
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
