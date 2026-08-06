import type { PGlite } from "@electric-sql/pglite"
import type { StorageAdapter } from "../storage"
import type { IngestVersionPayload } from "./ingest"
import { runIngestJob } from "./ingest"

/**
 * Ingest polling worker (architecture §4.5, decision 35).
 *
 * Hand-rolled `FOR UPDATE SKIP LOCKED` polling loop on top of
 * PGlite. A dedicated job-queue package was tried first and
 * proved incompatible with pglite-socket's connection
 * multiplexer (prepared-statement caching interacts poorly with
 * the per-connection rotation); the polling loop below avoids
 * that pathway by claiming rows from `module_versions` directly
 * — see `library/registry-ingest-worker.md` and architecture §8
 * decision 35 for the full abandonment note. The semantics are
 * identical to a job-queue abstraction:
 *
 *   - jobs are claimed atomically (UPDATE-WHERE RETURNING)
 *   - jobs are at-least-once (a crash mid-flight leaves the row
 *     in `ingesting`; the boot + per-cycle sweep resets it)
 *   - jobs are idempotent (the orchestrator writes the same
 *     terminal state regardless of how many times it runs)
 *
 * Tradeoffs vs a dedicated job queue:
 *
 *   - (+) No pglite-socket interaction issues.
 *   - (+) Job retention is the `module_versions` row itself; no
 *     extra job-queue tables to keep in sync.
 *   - (-) No cron support (out of scope for v1).
 *   - (-) No retry-with-backoff (out of scope; v1 is `maxAttempts: 1`).
 *   - (-) No distributed coordination beyond `FOR UPDATE SKIP LOCKED`.
 *
 * Error-routing invariant: the per-cycle catch below ONLY logs to
 * stderr — it does NOT mark the row failed. Errors that escape
 * `runIngestJob` leave the row cycling `ingesting → pending` on
 * every sweep forever; the executor's own wrapper (`ingest.ts`)
 * is the load-bearing place where every failure path routes
 * through `markFailed`. Do not weaken that contract.
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
 * Polls `module_versions` for rows with status='pending' (after a
 * sweep may have just reset stale ingesting rows) and dispatches
 * them to `runIngestJob`. Returns a handle the caller can use to
 * stop the worker.
 *
 * Configuration:
 *
 *   - `pollIntervalMs` defaults to 1000 (1s).
 *   - The atomic claim query resets `status='ingesting'` rows whose
 *     `updated_at` is older than `sweepThresholdMs` back to
 *     `pending` on each cycle. This is the "sweep" described in
 *     architecture §4.5 — it converges kill-resume cases.
 */
export async function startWorker(opts: {
	pglite: PGlite
	storage: StorageAdapter
	pollIntervalMs?: number
	/**
	 * Override the per-cycle sweep threshold (ms, VAL-PUB-028).
	 * The runner also reads `REGISTRY_INGEST_STALE_MS` directly
	 * when this is omitted — the env knob is the operator-facing
	 * surface; the explicit argument is the test surface. The
	 * default is `120_000` (the contract ceiling).
	 */
	sweepThresholdMs?: number
}): Promise<WorkerHandle> {
	const pollIntervalMs = opts.pollIntervalMs ?? 1_000
	// Per-cycle sweep threshold (VAL-PUB-028). The explicit
	// argument wins; otherwise the env knob is consulted (with a
	// safe fallback in `sweepStaleIngestingRows` itself). The
	// default `120_000` is the contract ceiling — a healthy
	// registry converges a kill mid-ingest within the 120s poll
	// ceiling with no env configuration.
	const sweepThresholdMs = opts.sweepThresholdMs ?? 120_000

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
				// ignore — the row's terminal state is already
				// durable in module_versions; the runner's own
				// catch recorded it for the operator log.
			}
		}
	}

	let resolveStopped: () => void
	const stoppedPromise = new Promise<void>((resolve) => {
		resolveStopped = resolve
	})

	function checkStopped(): void {
		// Polled at cycle boundaries; the `stop` closure sets the
		// flag and may also be awaiting `currentJob`. Reaching
		// `stopped=true` from both pathways is the shared exit
		// signal.
		if (stopped) {
			resolveStopped()
		} else {
			setTimeout(checkStopped, 50)
		}
	}
	checkStopped()

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
			// Cycle errors are logged but do not stop the worker.
			// Note: runIngestJob's wrapper has ALREADY marked the
			// claimed row failed before this catch fires — the
			// log line is for operator forensics only.
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
