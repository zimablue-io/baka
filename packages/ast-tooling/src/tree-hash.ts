import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { join } from "node:path"
import type { ChangesetEntry } from "@repo/protocol"

/** sha256 of the bytes, lowercase hex. Strings are hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex")
}

/** Domain tag; bump it if the canonical form below ever changes. */
const TREE_HASH_DOMAIN = "baka.tree.v1"

/** Orders strings by their UTF-8 bytes, so the order never depends on the JS engine's string comparison. */
export function compareUtf8(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"))
}

/**
 * The output tree hash. Input is every changeset entry's (path, contentHash)
 * pair, with `deleted` standing in for a null hash. The canonical text is
 *
 *   baka.tree.v1\n
 *   <path>\0<contentHash>\n      (one line per entry, ascending by UTF-8 bytes of <path>)
 *
 * and the hash is the sha256 of that text, lowercase hex. Paths are
 * project-relative, POSIX-separated, and carry no leading `./`. The op and
 * reason of an entry are deliberately NOT hashed: two runs that leave the
 * same bytes at the same paths hash identically whether the first created
 * the files and the second found them already there.
 */
export function outputTreeHash(entries: ReadonlyArray<Pick<ChangesetEntry, "path" | "contentHash">>): string {
	const lines = [...entries]
		.sort((a, b) => compareUtf8(a.path, b.path))
		.map((e) => `${e.path}\0${e.contentHash ?? "deleted"}\n`)
	return sha256Hex(`${TREE_HASH_DOMAIN}\n${lines.join("")}`)
}

/** Which entries a walk ignores. `rel` is the entry's parent directory, relative to the walk root ("" at the root). */
interface WalkFilter {
	skipDir(name: string, rel: string): boolean
	skipFile(name: string): boolean
}

/**
 * path -> content hash for every file under `root`, walking depth-first.
 * Symlinks are hashed by their target text, never followed.
 */
function hashFiles(root: string, filter: WalkFilter): Map<string, string> {
	const out = new Map<string, string>()
	const walk = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const relPath = rel ? `${rel}/${entry.name}` : entry.name
			const abs = join(dir, entry.name)
			if (entry.isDirectory()) {
				if (!filter.skipDir(entry.name, rel)) walk(abs, relPath)
			} else if (filter.skipFile(entry.name)) {
			} else if (entry.isSymbolicLink()) {
				out.set(relPath, sha256Hex(`symlink:${readlinkSync(abs)}`))
			} else if (entry.isFile() && lstatSync(abs).isFile()) {
				out.set(relPath, sha256Hex(readFileSync(abs)))
			}
		}
	}
	walk(root, "")
	return out
}

/**
 * path -> content hash for every file under a project, so a side-effect
 * action can be diffed. `.git/`, `node_modules/`, and the root-level `.baka/`
 * are skipped.
 */
export function snapshotTree(root: string): Map<string, string> {
	return hashFiles(root, {
		skipDir: (name, rel) => name === ".git" || name === "node_modules" || (rel === "" && name === ".baka"),
		skipFile: () => false,
	})
}

/** Every file path under a project (relative, POSIX, sorted), skipping the same trees as `snapshotTree`. */
export function listProjectFiles(root: string): string[] {
	const out: string[] = []
	const walk = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const relPath = rel ? `${rel}/${entry.name}` : entry.name
			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules" || (rel === "" && entry.name === ".baka")) continue
				walk(join(dir, entry.name), relPath)
			} else out.push(relPath)
		}
	}
	walk(root, "")
	return out.sort(compareUtf8)
}

/** Every directory under a project (relative, POSIX), skipping the same trees as `snapshotTree`. */
export function snapshotDirectories(root: string): Set<string> {
	const out = new Set<string>()
	const walk = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			if (entry.name === ".git" || entry.name === "node_modules" || (rel === "" && entry.name === ".baka")) continue
			const relPath = rel ? `${rel}/${entry.name}` : entry.name
			out.add(relPath)
			walk(join(dir, entry.name), relPath)
		}
	}
	walk(root, "")
	return out
}

const MODULE_HASH_DOMAIN = "baka.module.v1"

/**
 * The content hash of a module: sha256 over
 *
 *   baka.module.v1\n
 *   <path>\0<sha256 of the file's bytes>\n    (one line per file, ascending by UTF-8 bytes of <path>)
 *
 * for every file under the module directory, with paths relative to it and
 * POSIX-separated. Symlinks count as their target text. Skipped, because they
 * are install or tool residue and not the module: `node_modules/`, `.git/`,
 * and `out/` directories, `.DS_Store`, and `.design-state.json`.
 */
export function moduleContentHash(moduleRoot: string): string {
	const files = hashFiles(moduleRoot, {
		skipDir: (name) => name === "node_modules" || name === ".git" || name === "out",
		skipFile: (name) => name === ".DS_Store" || name === ".design-state.json",
	})
	const lines = [...files].sort(([a], [b]) => compareUtf8(a, b)).map(([path, hash]) => `${path}\0${hash}\n`)
	return sha256Hex(`${MODULE_HASH_DOMAIN}\n${lines.join("")}`)
}

/** create / update / delete entries between two snapshots, in canonical path order. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): ChangesetEntry[] {
	const entries: ChangesetEntry[] = []
	for (const [path, hash] of after) {
		const prior = before.get(path)
		if (prior === undefined) entries.push({ path, op: "create", contentHash: hash })
		else if (prior !== hash) entries.push({ path, op: "update", contentHash: hash })
	}
	for (const path of before.keys()) {
		if (!after.has(path)) entries.push({ path, op: "delete", contentHash: null })
	}
	return entries.sort((a, b) => compareUtf8(a.path, b.path))
}
