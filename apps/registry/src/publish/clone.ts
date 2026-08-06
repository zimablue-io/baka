import { execFile as execFileCb } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

/**
 * Shallow git clone at a specific tag (architecture §4.5 / §6).
 *
 * The publish endpoint uses a shallow clone to validate the
 * module manifest at publish time so the bare-name rule
 * (VAL-PUB-010) and the manifest/tag version match (VAL-PUB-024)
 * can be checked BEFORE the row is created. The worker
 * (next milestone) re-clones the repo for the full ingest
 * pipeline; the publish-time clone is a deliberate duplication
 * kept narrow (depth=1, single tag) so the network cost is
 * bounded.
 *
 * The clone honors `INGEST_CLONE_TIMEOUT_MS` (default 60_000)
 * — the same knob the worker uses — so a stalled remote fails
 * the publish rather than wedging the request.
 *
 * On success the caller receives the temporary directory path
 * and is responsible for deleting it (via `cleanupClone` or
 * `rm({ recursive: true })`); the clone helper does NOT delete
 * the directory on its own so the caller can read files from
 * it as long as it needs.
 */

const execFile = promisify(execFileCb)

const DEFAULT_CLONE_TIMEOUT_MS = 60_000

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
	try {
		// `--depth 1` keeps the network small; `--branch <tag>` pins
		// the clone to the exact tag so the manifest read matches the
		// version string the publish body declared.
		await execFile("git", ["clone", "--depth", "1", "--branch", tag, repo, dir], {
			timeout: effectiveTimeout,
		})
		const rev = await execFile("git", ["-C", dir, "rev-parse", "HEAD"], {
			timeout: 5_000,
		})
		const commitSha = rev.stdout.trim()
		return { dir, commitSha }
	} catch (err) {
		await rm(dir, { recursive: true, force: true }).catch(() => {})
		throw err
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
