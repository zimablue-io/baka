import type { PGlite } from "@electric-sql/pglite"
import type { PerActionResult } from "./dry-run"

/**
 * `screening_previews` row payload (architecture §4.3, dry-run layer).
 *
 * The `state` column is the CHECK-constrained subset:
 *   - "rendered"   — action ran successfully; `files` populated.
 *   - "needs-llm"  — `requiresReasoning: true`; not executed; `error`
 *                    holds the skip reason ("action skipped because it
 *                    requires LLM reasoning"); `files` is null.
 *   - "failed"     — execution failed (e.g. fs-escape `ERR_ACCESS_DENIED`,
 *                    runtime error); `error` holds the diagnostic;
 *                    `files` is null (the sandbox may have been
 *                    partially populated but is wiped on exit, so we
 *                    do not surface partial outputs).
 *   - "timed-out"  — exceeded the per-action timeout; `timed_out_at`
 *                    carries the ISO timestamp; `error` is null (the
 *                    verdict text states the policy, not the timeout).
 *
 * UPSERT semantics on (version_id, action_id): a re-run of the dry-run
 * overwrites the previous row cleanly via `ON CONFLICT ... DO UPDATE`.
 */
type PreviewState = "rendered" | "needs-llm" | "failed" | "timed-out"

interface PreviewFileRow {
	path: string
	contentHash: string
	size: number
	storageKey: string
}

interface PreviewRecordRow {
	versionId: string
	actionId: string
	state: PreviewState
	files: PreviewFileRow[] | null
	error: string | null
	timedOutAt: Date | null
}

/**
 * Upserts the per-action dry-run outcome into `screening_previews`.
 * Each per-action result carries the verdict text in its own field;
 * the row's `state` column is the discriminator the read surface uses
 * to render the preview list.
 *
 * The function is idempotent on (version_id, action_id): a re-run of
 * the same action (operator-driven re-publish at a new tag) overwrites
 * the previous row's state / files / error in one statement.
 */
export async function writePreviewRecord(pglite: PGlite, result: PerActionResult, versionId: string): Promise<void> {
	const row: PreviewRecordRow = toRow(result, versionId)
	await pglite.query(
		`INSERT INTO screening_previews (version_id, action_id, state, files, error, timed_out_at)
		   VALUES ($1, $2, $3, $4::jsonb, $5, $6)
		 ON CONFLICT (version_id, action_id) DO UPDATE
		   SET state = EXCLUDED.state,
		       files = EXCLUDED.files,
		       error = EXCLUDED.error,
		       timed_out_at = EXCLUDED.timed_out_at,
		       created_at = NOW()`,
		[
			row.versionId,
			row.actionId,
			row.state,
			row.files === null ? null : JSON.stringify(row.files),
			row.error,
			row.timedOutAt,
		],
	)
}

function toRow(result: PerActionResult, versionId: string): PreviewRecordRow {
	switch (result.status) {
		case "screened":
			return {
				versionId,
				actionId: result.actionId,
				state: "rendered",
				files: result.previewFiles.map((f) => ({
					path: f.path,
					contentHash: f.contentHash,
					size: f.size,
					storageKey: f.storageKey,
				})),
				error: null,
				timedOutAt: null,
			}
		case "needs-llm":
			return {
				versionId,
				actionId: result.actionId,
				state: "needs-llm",
				files: null,
				error: result.reason,
				timedOutAt: null,
			}
		case "failed":
			return {
				versionId,
				actionId: result.actionId,
				state: "failed",
				files: null,
				error: result.error,
				timedOutAt: null,
			}
		case "timed-out":
			return {
				versionId,
				actionId: result.actionId,
				state: "timed-out",
				files: null,
				error: null,
				timedOutAt: new Date(result.timedOutAt),
			}
	}
}
