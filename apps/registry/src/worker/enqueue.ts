/**
 * Ingest enqueue seam (architecture §4.5).
 *
 * The publish endpoint calls `enqueueIngest(versionId)` after
 * creating a new `module_versions` row. With the in-process
 * polling worker, this is a best-effort "tell the worker a new
 * row is ready" notification — the worker actually discovers
 * pending rows by polling `module_versions.status='pending'` on
 * each cycle. The `jobKey` dedup story moves from graphile-worker's
 * `_private_jobs.key` UNIQUE to the worker claim's
 * `FOR UPDATE SKIP LOCKED` atomicity (VAL-PUB-026): two concurrent
 * polls pick two different rows, never the same one.
 *
 * The seam is still useful for tests that want to assert "the
 * publish endpoint signaled a new row" without inspecting the DB.
 */

export interface IngestEnqueuer {
	/**
	 * Notify the worker that `versionId` was just created. Returns
	 * `1` if the notification was recorded, `0` if it was deduped
	 * (a second call for the same `versionId` within the test's
	 * capture window), `null` for a no-op enqueuer.
	 */
	enqueue(versionId: string): Promise<number | null>

	/**
	 * Resets the in-memory capture list (test-only).
	 */
	reset?(): void

	/**
	 * The list of versionIds notified since the last reset
	 * (test-only).
	 */
	captured?(): string[]
}

/**
 * Builds an in-memory `IngestEnqueuer` for tests. The `enqueue`
 * method appends to a captured list instead of touching the DB;
 * `reset` clears the list between assertions. The polling worker
 * still discovers pending rows via the DB, so this stub is
 * observable in tests but doesn't affect the worker's behavior.
 */
export function createInMemoryEnqueuer(): IngestEnqueuer {
	const captured: string[] = []
	return {
		async enqueue(versionId: string): Promise<number> {
			captured.push(versionId)
			return 1
		},
		reset(): void {
			captured.length = 0
		},
		captured(): string[] {
			return [...captured]
		},
	}
}
