import type { PGlite } from "@electric-sql/pglite"
import type { PerActionState } from "./dry-run"
import type { OutputValidationPayload } from "./output-validation"
import type { StaticScanResult } from "./static-scan"

/**
 * `screening_results` row payload (architecture §4.3).
 *
 *   - `verdict` is one of the CHECK-constrained values:
 *     `screened` / `unverified` / `failed`. The dry-run layer
 *     transitions `unverified` (post-static-scan) to `screened`
 *     (all non-reasoning actions passed), keeps it `unverified`
 *     (at least one action timed out — the row continues to
 *     `ready`), or sets `failed` (at least one action failed).
 *
 *   - `static_scan` carries the named findings from the static
 *     capability scan. The catalog surfaces this verbatim on
 *     the version-detail endpoint so the read-side can render
 *     the per-finding table without re-running the scan.
 *
 *   - `dry_run` is NULL when the dry-run layer has not run yet,
 *     the static-scan-failed skip marker when the static scan
 *     failed (so the catalog surfaces an explicit "dry-run
 *     skipped" marker instead of pretending the layer never ran),
 *     or the discriminated per-action payload after the dry-run
 *     completes (pass / unverified / failed).
 *
 *   - `output_validation` is the discriminated layer-3 payload
 *     (module's own validators + writes-subset-filePatterns
 *     check + declared output toolchain). NULL when the static
 *     scan or dry-run failed (the layer never ran); populated
 *     with the discriminated payload after layer 3 completes.
 *     The `step` discriminator names which sub-layer failed so
 *     the catalog can render an honest verdict text.
 *
 * The row is UPSERTED on `version_id` — a re-run of the worker
 * over the same row (operator-driven re-publish at a new tag,
 * etc.) leaves the most recent verdict in place.
 *
 * Internal-only type — not exported because every consumer is
 * the worker itself; future layers will reach for the same
 * shape and widen the type when they add new fields.
 */
interface DryRunSkipped {
	skipped: true
	reason: string
	at: string
}

interface DryRunCompleted {
	policy: string
	perAction: PerActionState[]
	timedOutAt?: string
	timeoutMs?: number
}

type DryRunPayload = DryRunSkipped | DryRunCompleted

interface ScreeningRow {
	verdict: "screened" | "unverified" | "failed"
	staticScan: StaticScanResult | Record<string, unknown>
	dryRun: DryRunPayload | null
	outputValidation?: OutputValidationPayload | null
}

/**
 * Upserts a `screening_results` row for the given version. The
 * row's `static_scan`, `dry_run`, and `output_validation` fields
 * are JSON-encoded so the catalog can read the named findings /
 * skip markers verbatim.
 *
 * Idempotent on `version_id`: re-running the static scan for the
 * same row (operator-driven re-publish) overwrites the previous
 * verdict with the latest scan result. Subsequent layers
 * (dry-run, validator gate) reuse the same UPSERT path so the
 * final row reflects the last layer to run.
 */
export async function writeScreeningResult(pglite: PGlite, versionId: string, payload: ScreeningRow): Promise<void> {
	await pglite.query(
		`INSERT INTO screening_results (version_id, verdict, static_scan, dry_run, output_validation)
		   VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
		 ON CONFLICT (version_id) DO UPDATE
		   SET verdict = EXCLUDED.verdict,
		       static_scan = EXCLUDED.static_scan,
		       dry_run = EXCLUDED.dry_run,
		       output_validation = EXCLUDED.output_validation,
		       created_at = NOW()`,
		[
			versionId,
			payload.verdict,
			JSON.stringify(payload.staticScan),
			payload.dryRun === null ? null : JSON.stringify(payload.dryRun),
			payload.outputValidation === undefined || payload.outputValidation === null
				? null
				: JSON.stringify(payload.outputValidation),
		],
	)
}
