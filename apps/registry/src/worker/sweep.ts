import type { PGlite } from "@electric-sql/pglite"

/**
 * Stale `ingesting` sweep + boot sweep (architecture §4.5 step 7,
 * VAL-PUB-028).
 *
 * The polling worker holds rows at `status='ingesting'` between
 * claim and terminal-write. A SIGKILL of the worker mid-job leaves
 * a row pinned at `ingesting` with no live claim holding it —
 * without a sweep that row would be stranded forever (no future
 * poll would pick it up, since the worker only claims rows that
 * are `pending`).
 *
 * Two sweep variants ship here:
 *
 *   - `bootSweepIngestingRows(pglite)` is UNCONDITIONAL: a
 *     freshly booted process owns no in-flight jobs (no claim,
 *     no live process), so every `ingesting` row at boot is
 *     definitionally orphaned. Resetting all of them in a single
 *     statement converges kill-resume cases within the worker's
 *     own poll cycle (well under the 120s contract ceiling for
 *     VAL-PUB-028).
 *
 *   - `sweepStaleIngestingRows(pglite, { thresholdMs })` is
 *     threshold-gated: only rows whose `updated_at` is older
 *     than the threshold are reset. The per-cycle sweep uses
 *     this variant — a row claimed a moment ago must NOT be
 *     reset while the worker is still processing it.
 *
 * Threshold knobs:
 *
 *   - `REGISTRY_INGEST_STALE_MS` env var overrides the default
 *     (`120_000`, the contract ceiling). Operators who need a
 *     more aggressive convergence bound set it lower.
 *   - The `thresholdMs` argument overrides both. The env var is
 *     only consulted when no explicit argument is supplied; a
 *     malformed env value falls back to the default (no boot
 *     crash).
 *
 * Why the boot sweep is unconditional (architecture §4.5, VAL-PUB-028):
 *
 *   The previous design used the same threshold-gated sweep at
 *   boot. Round-1 user testing killed a worker mid-ingest; the
 *   row stayed `ingesting` for ~301 seconds (5-minute default
 *   threshold, no env override) before the next per-cycle sweep
 *   reset it. That violated the 120s poll ceiling. A freshly
 *   booted process holds no in-flight jobs, so the boot sweep
 *   cannot "steal" a row from a live worker — there is no live
 *   worker to steal from. Resetting all `ingesting` rows at boot
 *   is therefore both correct AND the cheapest path to
 *   convergence.
 *
 * Per-cycle behavior:
 *
 *   - The runner calls `sweepStaleIngestingRows` on every cycle
 *     BEFORE the next claim; a row whose `updated_at` is younger
 *     than the threshold is left alone (the worker may still be
 *     legitimately working on it).
 *   - The threshold default is `120_000` (the contract ceiling)
 *     so a kill mid-ingest converges within ~120s on a healthy
 *     worker — matching the 120s poll ceiling in VAL-PUB-028.
 *     Operators who need tighter convergence set
 *     `REGISTRY_INGEST_STALE_MS=10000` (10s) or similar.
 */

const DEFAULT_STALE_INGEST_THRESHOLD_MS = 120_000

interface SweepResult {
	rowsReset: number
	staleThresholdMs: number
}

/**
 * Reads the sweep threshold from `REGISTRY_INGEST_STALE_MS` with a
 * safe fallback. A malformed value (non-numeric, zero, negative) is
 * ignored — the default applies and the registry boots. The env
 * knob is operator-facing, not test-facing; tests pass an explicit
 * `thresholdMs` argument.
 */
function readSweepThresholdFromEnv(): number {
	const raw = process.env.REGISTRY_INGEST_STALE_MS
	if (!raw) return DEFAULT_STALE_INGEST_THRESHOLD_MS
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STALE_INGEST_THRESHOLD_MS
	return parsed
}

/**
 * BOOT-TIME sweep: reset EVERY `ingesting` row to `pending`,
 * unconditionally. A freshly booted process owns no in-flight
 * jobs (no claim, no live process), so every `ingesting` row at
 * boot is definitionally orphaned. Resetting all of them
 * converges kill-resume cases within the worker's own poll cycle
 * — well under the 120s contract ceiling for VAL-PUB-028.
 *
 * Idempotent: re-running on a healthy data dir is a no-op (no
 * `ingesting` rows exist). The function is safe to call on every
 * boot; it does NOT block boot if no rows match.
 *
 * Returns the count of rows reset. The boot log in `server.ts`
 * records the count so an operator can see what was recovered.
 */
export async function bootSweepIngestingRows(pglite: PGlite): Promise<{ rowsReset: number }> {
	const result = await pglite.query<{ id: string }>(
		`UPDATE pack_versions
		    SET status = 'pending',
		        error = NULL,
		        updated_at = NOW()
		  WHERE status = 'ingesting'
		  RETURNING id`,
	)
	return { rowsReset: result.rows.length }
}

/**
 * Per-cycle threshold-gated sweep: reset `ingesting` rows whose
 * `updated_at` is older than `thresholdMs` back to `pending`. The
 * worker calls this on every poll cycle before claiming the next
 * row (a freshly-claimed row's `updated_at` is young enough to be
 * left alone; a row killed mid-job is older than the threshold
 * and is recovered).
 *
 * The default threshold is `120_000ms` (the contract ceiling for
 * VAL-PUB-028). The `REGISTRY_INGEST_STALE_MS` env var overrides
 * the default; an explicit `thresholdMs` argument overrides the
 * env. A malformed env value falls back to the default — the
 * helper never refuses to boot because of a bad knob.
 *
 * Returns `{ rowsReset, staleThresholdMs }` so the boot/cycle log
 * can record what happened. Idempotent — re-running on a healthy
 * data dir is a no-op.
 */
export async function sweepStaleIngestingRows(
	pglite: PGlite,
	opts: { thresholdMs?: number } = {},
): Promise<SweepResult> {
	const thresholdMs = opts.thresholdMs ?? readSweepThresholdFromEnv()
	const intervalLiteral = `${Math.floor(thresholdMs / 1000)} seconds`
	const result = await pglite.query<{ id: string }>(
		`UPDATE pack_versions
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
