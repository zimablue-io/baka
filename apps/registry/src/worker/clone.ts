import { execFile as execFileCb } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

/**
 * Bounded git clone used by the ingest worker (architecture §4.5,
 * §8 decision 6).
 *
 * The publish endpoint has its own narrow clone (publish-time name
 * and version check). The worker re-clones because it needs the full
 * module tree (manifest, action sources, templates) for the
 * loadability gate, the content hash, and the tarball pack.
 *
 * The clone is bounded by `INGEST_CLONE_TIMEOUT_MS` (default 120_000,
 * decision 6's documented ceiling) — a stalled remote fails the
 * version instead of wedging the worker. Any active child process is
 * killed via `AbortController` signal forwarding so no orphaned git
 * child processes survive a timeout (the contract's no-orphan
 * guarantee).
 *
 * On success the caller receives the temporary directory path and
 * the commit sha; the caller is responsible for deleting the
 * directory (via `cleanupClone` or `rm({ recursive: true })`). The
 * clone helper does NOT delete on its own so the caller can read
 * files from the worktree as long as it needs.
 */

const execFile = promisify(execFileCb)

const DEFAULT_CLONE_TIMEOUT_MS = 120_000

interface CloneResult {
	/** Path to the directory holding the cloned repo. */
	dir: string
	/** Commit sha at `tag`. Empty when the tag is malformed. */
	commitSha: string
}

/**
 * Clones `repo` shallow at `tag`. Throws on timeout (after killing
 * the child) with a message naming the repo and the tag.
 */
export async function shallowCloneAtTag(repo: string, tag: string, timeoutMs?: number): Promise<CloneResult> {
	const envTimeout = process.env.INGEST_CLONE_TIMEOUT_MS
		? Number.parseInt(process.env.INGEST_CLONE_TIMEOUT_MS, 10)
		: NaN
	const effectiveTimeout =
		timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_CLONE_TIMEOUT_MS)
	const dir = await mkdtemp(join(tmpdir(), "baka-ingest-"))
	const abort = new AbortController()
	const timeoutHandle = setTimeout(() => abort.abort(), effectiveTimeout)
	try {
		// `--depth 1` keeps the network small; `--branch <tag>` pins
		// the clone to the exact tag so the worker's loadability gate
		// and tarball pack operate on the version the publish endpoint
		// recorded (architecture §4.5: served version equals git tag).
		await execFile("git", ["clone", "--depth", "1", "--branch", tag, repo, dir], {
			timeout: effectiveTimeout,
			signal: abort.signal,
		})
		const rev = await execFile("git", ["-C", dir, "rev-parse", "HEAD"], {
			timeout: 5_000,
		})
		const commitSha = rev.stdout.trim()
		return { dir, commitSha }
	} catch (err) {
		await rm(dir, { recursive: true, force: true }).catch(() => {})
		const reason = abort.signal.aborted ? "timeout" : err instanceof Error ? err.message : String(err)
		throw new Error(`git clone failed for ${repo} at tag '${tag}': ${reason}`)
	} finally {
		clearTimeout(timeoutHandle)
	}
}

/**
 * Removes the clone directory. Idempotent — a missing directory is
 * not an error. Callers should invoke this on every exit path.
 */
export async function cleanupClone(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true }).catch(() => {})
}
