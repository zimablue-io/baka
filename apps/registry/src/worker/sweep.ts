import type { PGlite } from "@electric-sql/pglite"

/**
 * Boot sweep for stale `ingesting` rows (architecture §4.5 step 7,
 * VAL-PUB-028).
 *
 * A SIGKILL of the worker process mid-job leaves a `module_versions`
 * row pinned at `status='ingesting'` with no live job holding it.
 * Without a sweep, that row would be stranded forever (no future
 * poll would pick it up — the worker only claims rows that are
 * `pending`).
 *
 * The sweep resets every `ingesting` row whose `updated_at` is older
 * than `STALE_INGEST_THRESHOLD_MS` (default 5 minutes) back to
 * `pending`. The same atomic claim UPDATE in the worker (`runner.ts`)
 * then picks the row up on the next poll, the job re-runs from
 * scratch (the tarball pack is content-addressed so the dedup
 * invariant holds across re-runs), and the row converges to a
 * terminal state.
 *
 * A new row that was JUST claimed (e.g. the worker is mid-job right
 * now) is younger than the threshold and is left alone — the sweep
 * only touches truly stale rows.
 *
 * The worker ALSO runs the same sweep on every poll cycle
 * (`runner.ts`'s `sweepStaleIngestingRows`); the boot sweep here
 * ensures a row left `ingesting` by a previous crashed worker is
 * recovered before the worker's first claim attempt.
 */

const DEFAULT_STALE_INGEST_THRESHOLD_MS = 5 * 60 * 1_000

interface SweepResult {
	rowsReset: number
	staleThresholdMs: number
}

/**
 * Resets stale `ingesting` rows to `pending`. Returns the count of
 * rows reset and the threshold applied so the boot log can record
 * what happened. Idempotent — re-running on a healthy data dir is a
 * no-op.
 */
export async function sweepStaleIngestingRows(
	pglite: PGlite,
	opts: { thresholdMs?: number } = {},
): Promise<SweepResult> {
	const thresholdMs = opts.thresholdMs ?? DEFAULT_STALE_INGEST_THRESHOLD_MS
	const intervalLiteral = `${Math.floor(thresholdMs / 1000)} seconds`
	const result = await pglite.query<{ id: string }>(
		`UPDATE module_versions
		    SET status = 'pending',
		        error = NULL,
		        updated_at = NOW()
		  WHERE status = 'ingesting'
		    AND updated_at < NOW() - ($1)::interval
		  RETURNING id`,
		[`${intervalLiteral}`],
	)
	return { rowsReset: result.rows.length, staleThresholdMs: thresholdMs }
}
