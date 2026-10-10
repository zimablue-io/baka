import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { RecipeError } from "./errors.js"

/**
 * Path containment: every path the engine writes, reads for a write decision,
 * or deletes on rollback is a project-relative POSIX path that must stay
 * inside the project root. The rules, in the order they are applied:
 *
 * 1. Lexical: a non-empty string without NUL, control characters, or
 *    backslashes; not absolute (`/x`, `C:x`); no `..` segment; not the root
 *    itself; no `.git` segment anywhere and no root-level `.baka` (those hold
 *    hooks and installed packs, i.e. code that runs later).
 * 2. Resolution: after resolving symlinks, the deepest existing ancestor of
 *    the target lies inside the root's real path, and the target itself is
 *    not a symlink.
 *
 * Failures throw `RecipeError("path-escape")`.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f]/
const WINDOWS_DRIVE = /^[A-Za-z]:/

function reject(path: string, why: string): never {
	throw new RecipeError("path-escape", `path "${path}" ${why}`)
}

/**
 * The normalized form of a project-relative POSIX path (no `.` segments, no
 * doubled or trailing slashes), or a `path-escape` error. Purely lexical:
 * nothing is read from the disk.
 */
export function normalizeRelativePath(path: string): string {
	if (typeof path !== "string" || path === "") reject(String(path), "is empty")
	if (CONTROL.test(path)) reject(JSON.stringify(path), "contains a control character")
	if (path.includes("\\")) reject(path, "contains a backslash; use POSIX separators")
	if (path.startsWith("/") || WINDOWS_DRIVE.test(path))
		reject(path, "is absolute; paths are relative to the project root")
	const segments: string[] = []
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue
		if (segment === "..") reject(path, 'contains a ".." segment and would leave the project root')
		if (segment === ".git") reject(path, 'goes through ".git", which recipes may not write')
		segments.push(segment)
	}
	if (segments.length === 0) reject(path, "resolves to the project root itself")
	if (segments[0] === ".baka") reject(path, 'is inside ".baka", which recipes may not write')
	return segments.join("/")
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The longest existing ancestor of `abs` (itself when it exists), as a real path. */
function realDeepestExisting(abs: string): string {
	let probe = abs
	for (;;) {
		try {
			lstatSync(probe)
			return realpathSync(probe)
		} catch {
			const parent = dirname(probe)
			if (parent === probe) return probe
			probe = parent
		}
	}
}

/**
 * Resolve `rel` below `root` and return the absolute path, or throw
 * `path-escape` when it is not a contained, non-symlink target. The root need
 * not exist yet (a fresh project directory): then there is nothing to escape
 * through and only the lexical rules apply.
 */
export function resolveContained(root: string, rel: string): string {
	const clean = normalizeRelativePath(rel)
	const abs = join(root, ...clean.split("/"))
	if (!existsSync(root)) return abs
	const realRoot = realpathSync(root)
	let isLink = false
	try {
		isLink = lstatSync(abs).isSymbolicLink()
	} catch {
		// does not exist: only its ancestors matter
	}
	if (isLink) reject(rel, "is a symbolic link; recipes do not write through links")
	if (!isInside(realRoot, realDeepestExisting(abs)))
		reject(rel, "resolves outside the project root through a symbolic link")
	return abs
}

/**
 * Create `dir` (project-relative) and any missing ancestors one level at a
 * time, appending each directory actually created to `created`. The caller
 * has already validated `dir` with `resolveContained`.
 */
export function ensureDirectory(root: string, dir: string, created: string[]): void {
	if (dir === "" || dir === ".") return
	const segments = dir.split("/")
	let rel = ""
	for (const segment of segments) {
		rel = rel ? `${rel}/${segment}` : segment
		const abs = join(root, ...rel.split("/"))
		if (existsSync(abs)) continue
		mkdirSync(abs)
		created.push(rel)
	}
}

/** Remove each directory in `dirs` (last created first) if it is empty; non-empty ones are left. */
export function removeCreatedDirectories(root: string, dirs: readonly string[]): void {
	for (const rel of [...dirs].reverse()) {
		const abs = join(root, ...rel.split("/"))
		try {
			if (readdirSync(abs).length === 0) rmdirSync(abs)
		} catch {
			// already gone, or not a directory any more
		}
	}
}
