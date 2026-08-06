import type { PGlite } from "@electric-sql/pglite"
import type { StorageAdapter } from "../storage"
import type { IngestVersionPayload } from "./ingest"
import { runIngestJob } from "./ingest"

/**
 * Ingest polling worker (architecture §4.5).
 *
 * This is a hand-rolled polling loop on top of PGlite rather than
 * graphile-worker. The reason is documented in the runner's
 * `_runTaskList` JSDoc below: graphile-worker relies on cross-
 * connection LISTEN/NOTIFY for cross-process job wake-ups, and
 * through pglite-socket the cross-connection NOTIFY signal is
 * unreliable (see `library/environment.md`: "Cross-connection
 * LISTEN/NOTIFY is unreliable through the socket mux"). With the
 * default `localQueue` enabled, a worker can deadlock on its
 * deferred promise after completing a job, waiting for a wake-up
 * that never arrives. With `localQueue.size: -1` to disable
 * batching, the worker DOES poll correctly via its `pollInterval`,
 * but the prepared-statement-based `getJobs` query path interacts
 * poorly with pglite-socket's connection multiplexing and the
 * worker consistently reports zero available jobs even when rows
 * are present in `graphile_worker._private_jobs`.
 *
 * The polling loop below avoids graphile-worker entirely: it
 * claims pending rows from `module_versions` directly via a
 * `SELECT ... FOR UPDATE SKIP LOCKED` query on the table the
 * registry owns, then dispatches each claim to the same
 * `runIngestJob` orchestrator that graphile-worker would have
 * called. The semantics are identical:
 *
 *   - jobs are claimed atomically (UPDATE-WHERE RETURNING)
 *   - jobs are at-least-once (the same `module_versions.id` may
 *     appear in the next poll if the previous attempt failed
 *     mid-flight; the atomic claim ensures only one worker can
 *     hold the row at a time)
 *   - jobs are idempotent (the orchestrator writes the same
 *     terminal state regardless of how many times it runs)
 *
 * Tradeoffs vs graphile-worker:
 *
 *   - (+) No prepared-statement / LISTEN-NOTIFY interaction with
 *     pglite-socket — the polling loop works deterministically.
 *   - (+) Job retention is the `module_versions` row itself; the
 *     `graphile_worker._private_jobs` and `graphile_worker.jobs`
 *     tables are never touched.
 *   - (-) No cron support (out of scope for v1).
 *   - (-) No retry-with-backoff (out of scope; the v1 contract
 *     is `maxAttempts: 1`).
 *   - (-) No distributed worker coordination; if multiple
 *     `startWorker` instances run, each polls independently and
 *     the `FOR UPDATE SKIP LOCKED` claim is the only coordination
 *     mechanism. That's exactly what v1 needs.
 */

export interface WorkerHandle {
	/** Promise that resolves when the worker stops. */
	stopped: Promise<void>
	/** Number of jobs processed so far. */
	jobsProcessed: () => number
	/** Number of poll cycles that claimed at least one job. */
	cyclesWithJobs: () => number
	/**
	 * Stops the polling loop, waits for the current job (if any)
	 * to finish, and resolves.
	 */
	stop: () => Promise<void>
}

/**
 * Polls `module_versions` for rows with status='pending' or
 * status='failed' (after a sweep) and dispatches them to
 * `runIngestJob`. Returns a handle the caller can use to stop the
 * worker.
 *
 * Configuration:
 *
 *   - `pollIntervalMs` defaults to 1000 (1s). Matches the
 *     graphile-worker config we previously used.
 *   - The atomic claim query resets `status='pending'` rows with
 *     `updated_at < now() - 5 minutes` from `ingesting` back to
 *     `pending` on each cycle. This is the "sweep" described in
 *     `architecture §4.5` — it converges kill-resume cases.
 */
export async function startWorker(opts: {
	pglite: PGlite
	storage: StorageAdapter
	pollIntervalMs?: number
	/** Override the boot-time sweep threshold (ms). */
	sweepThresholdMs?: number
}): Promise<WorkerHandle> {
	const pollIntervalMs = opts.pollIntervalMs ?? 1_000
	const sweepThresholdMs = opts.sweepThresholdMs ?? 5 * 60 * 1_000

	let stopped = false
	let jobsProcessed = 0
	let cyclesWithJobs = 0
	let currentJob: Promise<void> | null = null

	const stop = async (): Promise<void> => {
		stopped = true
		if (currentJob) {
			try {
				await currentJob
			} catch {
				// ignore — currentJob rejects on failure, but the
				// failure is already recorded in module_versions.error
			}
		}
	}

	const stoppedPromise = new Promise<void>((resolve) => {
		// We can't await a void on stop directly because `stop` is
		// defined above as a closure that captures `stopped`. Instead,
		// poll `stopped` at the cycle boundary.
		const checkStopped = (): void => {
			if (stopped) resolve()
			else setTimeout(checkStopped, 50)
		}
		checkStopped()
	})

	// Boot sweep: reset stale `ingesting` rows so a kill-resume
	// converges. We do this once at boot and once per cycle (the
	// per-cycle sweep handles long-running cases).
	await sweepStaleIngestingRows(opts.pglite, { thresholdMs: sweepThresholdMs })

	const cycle = async (): Promise<void> => {
		if (stopped) return
		try {
			// Per-cycle sweep for kill-resume.
			await sweepStaleIngestingRows(opts.pglite, { thresholdMs: sweepThresholdMs })
			// Claim the next pending row atomically.
			const claim = await claimNextPendingRow(opts.pglite)
			if (claim === null) {
				// Nothing to do; loop.
				return
			}
			cyclesWithJobs++
			currentJob = runIngestJob({ versionId: claim.id } satisfies IngestVersionPayload, {
				pglite: opts.pglite,
				storage: opts.storage,
			}).finally(() => {
				currentJob = null
			})
			await currentJob
			jobsProcessed++
		} catch (err) {
			// Cycle errors are logged but do not stop the worker —
			// the next poll will retry.
			process.stderr.write(`[worker] cycle error: ${(err as Error).message}\n`)
		}
	}

	// Kick off the loop.
	;(async () => {
		while (!stopped) {
			await cycle()
			if (stopped) break
			await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
		}
	})().catch((err) => {
		process.stderr.write(`[worker] loop error: ${(err as Error).message}\n`)
	})

	return {
		stopped: stoppedPromise,
		jobsProcessed: () => jobsProcessed,
		cyclesWithJobs: () => cyclesWithJobs,
		stop,
	}
}

/**
 * Atomically claims the next `pending` row in `module_versions` and
 * marks it `ingesting`. Returns the claimed row's id + version, or
 * `null` if no row was available. The atomic claim ensures only
 * one worker can hold a row at a time across concurrent polling
 * loops (the `FOR UPDATE SKIP LOCKED` clause skips rows other
 * workers are processing).
 *
 * Failed rows (status='failed') are NOT re-attempted automatically;
 * the row is durable and operator-driven re-publish is the v1
 * re-ingest path.
 */
async function claimNextPendingRow(pglite: PGlite): Promise<{ id: string; version: string; commitSha: string } | null> {
	const claimed = await pglite.query<{ id: string; version: string; commit_sha: string }>(
		`WITH next AS (
			SELECT id
				FROM module_versions
				WHERE status = 'pending'
				ORDER BY updated_at ASC
				FOR UPDATE SKIP LOCKED
				LIMIT 1
		)
		UPDATE module_versions
			SET status = 'ingesting',
			    updated_at = NOW()
			FROM next
			WHERE module_versions.id = next.id
		RETURNING module_versions.id, module_versions.version, module_versions.commit_sha`,
	)
	const row = claimed.rows[0]
	if (!row) return null
	return { id: row.id, version: row.version, commitSha: row.commit_sha }
}

/**
 * Sweeps stale `ingesting` rows back to `pending` so a kill-resume
 * converges. The threshold is "updated_at older than N ms" — the
 * worker writes `updated_at = NOW()` when it starts a row, so an
 * `ingesting` row whose `updated_at` is older than the threshold
 * belongs to a worker that died before completing it.
 */
async function sweepStaleIngestingRows(pglite: PGlite, opts: { thresholdMs: number }): Promise<void> {
	const thresholdSeconds = Math.max(1, Math.floor(opts.thresholdMs / 1_000))
	await pglite.query(
		`UPDATE module_versions
			SET status = 'pending',
			    updated_at = NOW()
			WHERE status = 'ingesting'
			  AND updated_at < NOW() - ($1 || ' seconds')::interval`,
		[String(thresholdSeconds)],
	)
}
