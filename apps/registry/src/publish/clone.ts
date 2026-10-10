import { execFile as execFileCb } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

/**
 * Shallow git clone at a specific tag (architecture §4.5 / §6).
 *
 * The publish endpoint uses a shallow clone to validate the
 * pack manifest at publish time so the bare-name rule
 * (VAL-PUB-010) and the manifest/tag version match (VAL-PUB-024)
 * can be checked BEFORE the row is created. The worker
 * (next milestone) re-clones the repo for the full ingest
 * pipeline; the publish-time clone is a deliberate duplication
 * kept narrow (depth=1, single tag) so the network cost is
 * bounded.
 *
 * The clone honors `INGEST_CLONE_TIMEOUT_MS` (default 120_000 —
 * the contract's 120s poll ceiling for VAL-PUB-023, matching the
 * worker clone's default; the two sites are unified at the same
 * value so an operator can tune both at once). The publish and
 * worker clones share the env knob on purpose: a publish that
 * times out at 60s while the worker's clone has 120s would be a
 * silent contract drift; unifying the default at 120s makes both
 * sites equally bounded by the same wall-clock budget.
 *
 * On success the caller receives the temporary directory path
 * and is responsible for deleting it (via `cleanupClone` or
 * `rm({ recursive: true })`); the clone helper does NOT delete
 * the directory on its own so the caller can read files from
 * it as long as it needs.
 *
 * Timeout error wrapping (VAL-PUB-023): the round-1 user-testing
 * finding was that the publish endpoint's timeout fired at 60s
 * (the previous default) and the error body was the raw execFile
 * `Command failed: git clone ...` message with no "timeout"
 * wording — a timeout was indistinguishable from a fast clone
 * failure. We now wrap the timeout path with a message that
 * names the timeout AND the configured duration in milliseconds,
 * e.g. `git clone timed out after 120000ms for <repo> at tag
 * '<tag>'`. The wrapper is the load-bearing surface for the
 * "timeout named in error" contract criterion.
 */

const execFile = promisify(execFileCb)

const DEFAULT_CLONE_TIMEOUT_MS = 120_000

interface CloneResult {
	/** Path to the directory holding the cloned repo. */
	dir: string
	/** The commit sha at `tag`. Empty when the tag is malformed. */
	commitSha: string
}

export async function shallowCloneAtTag(repo: string, tag: string, timeoutMs?: number): Promise<CloneResult> {
	const envTimeout = process.env.INGEST_CLONE_TIMEOUT_MS
		? Number.parseInt(process.env.INGEST_CLONE_TIMEOUT_MS, 10)
		: NaN
	const effectiveTimeout =
		timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_CLONE_TIMEOUT_MS)
	const dir = await mkdtemp(join(tmpdir(), "baka-publish-"))
	const abort = new AbortController()
	const timeoutHandle = setTimeout(() => abort.abort(), effectiveTimeout)
	try {
		// `--depth 1` keeps the network small; `--branch <tag>` pins
		// the clone to the exact tag so the manifest read matches the
		// version string the publish body declared.
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
		if (abort.signal.aborted) {
			// Timeout path (VAL-PUB-023). See the wrapper note at
			// the top of this file: the message names the timeout
			// and the configured duration so an operator can route
			// a slow clone to a budget tweak without parsing free
			// text. The AbortController signal kills the active git
			// child so no orphaned processes survive the timeout.
			throw new Error(`git clone timed out after ${effectiveTimeout}ms for ${repo} at tag '${tag}'`)
		}
		const reason = err instanceof Error ? err.message : String(err)
		throw new Error(`git clone failed for ${repo} at tag '${tag}': ${reason}`)
	} finally {
		clearTimeout(timeoutHandle)
	}
}

/**
 * Removes the clone directory. Idempotent — a missing directory
 * is not an error. Callers should invoke this on every exit
 * path (success, validation failure, exception).
 */
export async function cleanupClone(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true }).catch(() => {})
}
