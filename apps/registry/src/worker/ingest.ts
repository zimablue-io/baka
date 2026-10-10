import type { PGlite } from "@electric-sql/pglite"
import type { PackManifest } from "@repo/protocol"
import { type DryRunResult, runDryRun } from "../screening/dry-run"
import { runOutputValidation } from "../screening/output-validation"
import { writeScreeningResult } from "../screening/screening-result"
import { runStaticScan, type StaticScanFinding } from "../screening/static-scan"
import { updatePackTierForVerdict } from "../screening/tier-assignment"
import { cleanupClone, shallowCloneAtTag } from "./clone"
import { checkLoadability, IngestFailure, loadManifest } from "./manifest"
import { packTarball } from "./tarball"

/**
 * The payload of a single ingest job. Just the `versionId` — the
 * rest of the row data (commit_sha, manifest, pack_id, ...) is
 * fetched fresh from the DB at the top of `runIngestJob`. This
 * shape is the only thing that crosses the publish → worker
 * boundary.
 */
export interface IngestVersionPayload {
	versionId: string
}

/**
 * Ingest task executor (architecture §4.5).
 *
 * One job per `pack_versions` row: shallow-clone the repo at the
 * requested tag, locate the pack dir (via `packPath`), validate
 * the manifest via jiti against `PackManifestSchema`, run the
 * loadability gate, content-hash, pack the tarball, store via the
 * storage adapter, and flip status to `ready`. Failure at any step
 * flips status to `failed` with a diagnostic in `pack_versions.error`.
 *
 * The polling worker in `./runner.ts` is responsible for claiming
 * the row (UPDATE status='pending' → 'ingesting' with FOR UPDATE
 * SKIP LOCKED) BEFORE invoking this function. The re-claim
 * inside `runIngestJob` is a defense-in-depth check that the row
 * is still in `pending` (rather than some other terminal status);
 * the worker's claim already moved it to `ingesting`, so this
 * function only validates that the row exists and reads its data.
 *
 * Idempotency:
 *   - The atomic claim in the worker (`runner.ts`) prevents two
 *     workers from processing the same row simultaneously.
 *   - A re-run on a `ready` row is a no-op (the worker's claim
 *     returns no rows). A re-run on a `failed` row is allowed
 *     (operator-driven re-run is out of scope for v1; we keep the
 *     existing failure record and do not clear it).
 *
 * Crash-resume:
 *   - The boot-time sweep (`./sweep.ts`) and the per-poll sweep
 *     (`runner.ts`) reset any rows that are stuck in `ingesting`
 *     (no live worker holds them) back to `pending` before the
 *     next poll picks them up. The row converges to a terminal
 *     state.
 *   - The tarball is written to the storage adapter AFTER all
 *     intermediate state is durable — a crash mid-pack leaves no
 *     artifact blob (the storage adapter only sees the bytes when
 *     the pack is complete).
 *
 * Timeouts (architecture §8 decision 6):
 *   - `INGEST_CLONE_TIMEOUT_MS` bounds the clone (default 120s).
 *   - The loadability gate, manifest read, and tarball pack are
 *     bounded by an explicit `PGlite` query timeout and the
 *     polling loop's per-cycle ceiling.
 *   - No cloned child process can outlive a timeout: the clone
 *     helper uses an AbortController that kills the child process.
 *
 * Error routing invariant (scrutiny-round-1 fix):
 *   The runner's per-cycle catch (`runner.ts`) only logs to stderr
 *   — it does NOT mark the row failed. Every error that escapes
 *   `runIngestJob` must therefore terminate the row failed with
 *   diagnostics BEFORE the function returns or throws. The single
 *   `try { ... } catch { markFailed; rethrow }` wrapper below is
 *   the load-bearing mechanism for this invariant. Pinning test:
 *   `ingest-worker.test.ts` "an unreachable re-clone after publish
 *   terminates the row failed with diagnostics" — the bare fixture
 *   repo is deleted AFTER the publish returns 202 and BEFORE the
 *   worker re-clones, so the only way the row reaches `failed` is
 *   via this wrapper.
 */

interface IngestRow {
	id: string
	pack_id: string
	version: string
	commit_sha: string
	manifest: PackManifest & { _publish?: PublishPayload }
	status: string
	error: string | null
	created_at: Date
}

interface PackRow {
	id: string
	scope: string
	name: string
	visibility: string
	tier: string
}

interface PublishPayload {
	repo: string
	packPath: string | null
	visibility: string
	publishedAt: string
}

interface IngestDeps {
	pglite: PGlite
	storage: import("../storage").StorageAdapter
	/**
	 * Per-recipe dry-run timeout in milliseconds (architecture §8
	 * decision 6). Forwarded to the dry-run executor; `undefined`
	 * falls back to the executor's 60s default.
	 */
	screenDryRunTimeoutMs?: number
}

interface ArtifactInput {
	versionId: string
	kind: "tarball"
	contentHash: string
	size: number
	storageKey: string
}

/**
 * The polling-worker task executor. Receives a strictly-typed
 * `IngestVersionPayload` (just the versionId — the row carries
 * everything else). Returns when the row reaches a terminal
 * state (`ready` or `failed`).
 *
 * Throws `IngestFailure` for any expected failure (loadability
 * rejected, manifest missing, etc.); the wrapper below converts
 * those to `markFailed` calls. Unexpected errors (network, DB,
 * pack, store) follow the same path — they are also errors and
 * must also reach `failed`. The polling loop's next cycle will
 * not pick the row up again (its status is no longer `pending`),
 * so the contract is one polling cycle → one terminal state,
 * never "still ingesting" forever.
 *
 * The polling worker's claim (`runner.ts`) moved the row from
 * `pending` to `ingesting` BEFORE invoking this function, so the
 * `status !== "pending"` check below is a defensive belt-and-
 * braces: a re-run on a `ready` row is a no-op (another worker
 * beat us to it). The worker's own `FOR UPDATE SKIP LOCKED`
 * claim is the source of truth for "I am the worker processing
 * this version".
 */
export async function runIngestJob(payload: IngestVersionPayload, deps: IngestDeps): Promise<void> {
	let terminalErr: Error | null = null
	try {
		await runIngestJobInner(payload, deps)
	} catch (err) {
		// Every failure path — clone, packPath escape, manifest
		// load, loadability gate, pack, store, DB — must terminate
		// the row failed with diagnostics. We rethrow after marking
		// so the runner's per-cycle catch still observes the failure
		// for logging, but the row is durable in its terminal state.
		//
		// VAL-SCAN-018: a screening crash reports honestly, never
		// as a pass. An exception that escapes the screening block
		// (e.g. a detector bug, an unexpected runtime error in
		// `runStaticScan` itself) routes through this catch — the
		// version is marked `failed` AND the pack's tier falls
		// back to `community-unverified`. The tier update runs
		// BEFORE the markFailed write so a follow-up crash during
		// the markFailed path still leaves the catalog badge
		// honest. The `pack_id` lookup can fail if the row was
		// deleted mid-flight; we tolerate that gracefully (the
		// catalog cannot surface a tier on a missing pack
		// anyway).
		const message = err instanceof Error ? err.message : String(err)
		await markScreeningCrashTierTransition(deps.pglite, payload.versionId)
		try {
			await markFailed(deps.pglite, payload.versionId, message)
		} catch (markErr) {
			// If even the markFailed write fails, log the secondary
			// error so the operator can investigate; the row will
			// still be swept back to `pending` by the next cycle and
			// the worker will retry on a fresh claim.
			const secondary = markErr instanceof Error ? markErr.message : String(markErr)
			process.stderr.write(
				`[ingest] failed to markFailed for ${payload.versionId}: ${secondary} (original: ${message})\n`,
			)
		}
		terminalErr = err instanceof Error ? err : new Error(String(err))
		throw terminalErr
	}
}

/**
 * Inner execution: every step is unguarded (the wrapper above
 * routes ALL exceptions through markFailed). Internal helpers
 * throw either `IngestFailure` (expected — keeps the source line
 * in the diagnostic) or plain `Error` (pack/store/DB faults —
 * the wrapper converts them too).
 */
async function runIngestJobInner(payload: IngestVersionPayload, deps: IngestDeps): Promise<void> {
	const row = await fetchRow(deps.pglite, payload.versionId)
	if (row === null) {
		// The row was deleted between claim and execution — should
		// not happen in practice, but the polling worker MUST NOT
		// crash if it does.
		return
	}
	if (row.status === "ready") {
		// The polling worker's claim already moved this row to
		// `ingesting` (or it was just-converged). If we observe
		// `ready` here, a concurrent worker beat us to it. No-op.
		return
	}
	if (row.status === "failed") {
		// An operator-driven re-run is out of scope for v1; the
		// existing failure record is preserved.
		return
	}

	const packRow = await fetchPack(deps.pglite, row.pack_id)
	if (packRow === null) {
		throw new IngestFailure("manifest", `pack row missing for id '${row.pack_id}' (cannot determine scope/name)`)
	}

	// Read repo + packPath from the INGESTED row's own _publish
	// payload (scrutiny-round-1 fix #2). Earlier the worker queried
	// manifest->_publish from the pack's NEWEST version row, which
	// silently redirected an older pending version onto a newer
	// version's repo/packPath when two versions were queued
	// simultaneously. The row's own payload is the canonical source;
	// `_publish` is written by the publish endpoint at the moment the
	// row is created.
	const publish = row.manifest._publish
	if (!publish || typeof publish.repo !== "string" || publish.repo.length === 0) {
		throw new IngestFailure(
			"manifest",
			`publish body not found for pack '${packRow.scope}/${packRow.name}' (cannot determine repo URL)`,
		)
	}
	const repoUrl = publish.repo
	const packPath = typeof publish.packPath === "string" && publish.packPath.length > 0 ? publish.packPath : null

	// Step 1 — clone (bounded by INGEST_CLONE_TIMEOUT_MS, default 120s).
	const clone = await shallowCloneAtTag(repoUrl, row.version)

	// Re-clone commit_sha verification (library/registry-publish-endpoint.md):
	// The publish endpoint recorded the commit_sha it observed for this
	// row; if the tag moved between publish and ingest, the re-clone's
	// sha diverges from the row's commit_sha. In that case the row's
	// served version would not equal the row's content (decision 11).
	// We fail the version honestly so a re-publish at the new tag is
	// required. Without this check, the worker would happily pack a
	// tarball from a tag-pushed tree that no longer matches what was
	// originally recorded.
	if (row.commit_sha.length > 0 && clone.commitSha.length > 0 && clone.commitSha !== row.commit_sha) {
		await cleanupClone(clone.dir)
		throw new IngestFailure(
			"manifest",
			`re-clone commit_sha '${clone.commitSha}' at tag '${row.version}' differs from the publish-time commit_sha '${row.commit_sha}' — the tag moved; re-publish required`,
		)
	}

	try {
		// Step 2 — locate pack dir.
		const packDir = resolvePackDir(clone.dir, packPath)

		// Step 3 — validate manifest (jiti + PackManifestSchema).
		const manifest = await loadManifest(packDir)

		// Verify the worker's parsed manifest agrees with the version
		// the row already records — the publish endpoint did the
		// tag/manifest match check, but the worker re-evaluates the
		// FULL schema so a future bug in the narrow reader does not
		// silently corrupt the DB. A mismatch here is a server bug,
		// not a publish-side problem; we still mark failed.
		const rowManifestVersion = stripV((row.manifest as { version?: string }).version ?? "")
		const freshManifestVersion = stripV(manifest.version)
		if (rowManifestVersion !== freshManifestVersion) {
			throw new IngestFailure(
				"manifest",
				`worker's parsed manifest version '${manifest.version}' disagrees with publish-time version '${rowManifestVersion || "(missing)"}'`,
			)
		}

		// Step 4 — static capability scan (architecture §4.6 layer 1,
		// VAL-SCAN-002 / 015 / 016 / 018). Public-visibility packs
		// enter the screening pipeline; org-visibility packs skip it
		// entirely (decision 30, "private by default"). The scan
		// never executes the pack's own code — it parses every
		// `.ts` file with the TypeScript Compiler API and walks
		// every Handlebars template with a regex detector, looking
		// for network / child_process / eval / dynamic-import /
		// writes-outside-patterns / handlebars-helper violations.
		//
		// Why the static scan runs BEFORE the loadability gate: the
		// TypeScript Compiler API is permissive — a syntax error
		// produces a partial AST + a `parse` diagnostic, never a
		// thrown exception. The loadability gate uses jiti, which
		// is STRICT — a syntax error throws `ParseError` mid-import.
		// Running the static scan first means a broken `.ts` file
		// surfaces as a `parse` finding (recorded honestly on the
		// screening_results row, VAL-SCAN-018) instead of crashing
		// the loadability gate with no screening record. The
		// loadability gate still runs after a clean static scan to
		// catch unloadable recipes / validators.
		//
		// On failure: write a screening_results row with verdict
		// 'failed' + the static_scan payload + an explicit dry_run
		// skip marker, then throw IngestFailure so the wrapper
		// routes the version to `failed` with the honest diagnostic.
		// The dry-run layer is NEVER invoked for a version that did
		// not pass the static scan — the dry_run field carries the
		// skip reason so the read surface can explain why no
		// preview artifacts exist.
		//
		// On pass: write a screening_results row with verdict
		// 'unverified' (the overall verdict only becomes 'screened'
		// once the dry-run + output-validation layers complete).
		// This lets the catalog surface "static scan passed" without
		// prematurely claiming screened status.
		if (packRow.visibility === "public") {
			const staticResult = await runStaticScan(packDir, manifest)
			if (!staticResult.passed) {
				await runScreeningFailureStep(deps.pglite, payload.versionId, staticResult, packRow.id)
				return
			}
			await runDryRunStep(deps, payload.versionId, packDir, manifest, staticResult, packRow.id)
		}

		// Step 5 — loadability gate: every recipe, every pack
		// validator, and every recipe validator must resolve through
		// the real engine loader (scrutiny-round-1 fix #3). Previously
		// the gate iterated recipes only, so a pack with a missing
		// validator file reached `ready` and failed later at user-side
		// `baka validate` — the dishonesty this gate exists to prevent.
		await checkLoadability(packDir, manifest)

		// Step 6 — content hash + tarball pack.
		const pack = await packTarball(packDir)

		// Step 7 — store the tarball via the storage adapter
		// (content-addressed dedup is the adapter's responsibility).
		const stored = await deps.storage.put(pack.bytes)

		// Step 8 — record the artifact row (idempotent via UPSERT on
		// (version_id, kind, path)) and finalize the version row.
		await recordArtifact(deps.pglite, {
			versionId: payload.versionId,
			kind: "tarball",
			contentHash: stored.sha256,
			size: stored.size,
			storageKey: stored.key,
		})
		await markReady(deps.pglite, payload.versionId, stored.sha256)
	} finally {
		// Step 9 — always clean up the clone directory.
		await cleanupClone(clone.dir)
	}
}

async function fetchRow(pglite: PGlite, versionId: string): Promise<IngestRow | null> {
	const result = await pglite.query<IngestRow>(
		`SELECT id, pack_id, version, commit_sha, manifest, status, error, created_at
		   FROM pack_versions
		  WHERE id = $1`,
		[versionId],
	)
	return result.rows[0] ?? null
}

async function fetchPack(pglite: PGlite, packId: string): Promise<PackRow | null> {
	const result = await pglite.query<PackRow>(`SELECT id, scope, name, visibility, tier FROM packs WHERE id = $1`, [
		packId,
	])
	return result.rows[0] ?? null
}

async function markReady(pglite: PGlite, versionId: string, contentHash: string): Promise<void> {
	await pglite.query(
		`UPDATE pack_versions
		    SET status = 'ready',
		        content_hash = $1,
		        error = NULL,
		        updated_at = NOW()
		  WHERE id = $2`,
		[contentHash, versionId],
	)
}

async function markFailed(pglite: PGlite, versionId: string, error: string): Promise<void> {
	await pglite.query(
		`UPDATE pack_versions
		    SET status = 'failed',
		        error = $1,
		        updated_at = NOW()
		  WHERE id = $2`,
		[error, versionId],
	)
}

/**
 * Tier transition for a screening crash (VAL-SCAN-018). A
 * detector bug or an unexpected runtime error inside the
 * screening block (runStaticScan, runDryRun, runOutputValidation)
 * propagates out as an exception — the wrapper catches it and
 * marks the version `failed`, but the catalog badge must also
 * reflect the honest "screening could not complete" state. This
 * helper resolves the version's pack id and applies the
 * tier transition; if the pack row is missing (e.g. deleted
 * mid-flight) the UPDATE is a no-op and the function returns
 * silently.
 *
 * Why a separate helper: the tier UPDATE is intentionally NOT
 * inside the same try/catch as markFailed — a tier failure
 * must not block the version's terminal-state write, but the
 * catalog's honesty depends on the tier update completing
 * whenever the pack row exists.
 */
async function markScreeningCrashTierTransition(pglite: PGlite, versionId: string): Promise<void> {
	const versionRow = await pglite.query<{ pack_id: string }>(`SELECT pack_id FROM pack_versions WHERE id = $1`, [
		versionId,
	])
	const packId = versionRow.rows[0]?.pack_id
	if (!packId) return
	try {
		await updatePackTierForVerdict(pglite, packId, "failed")
	} catch (err) {
		// Tier update failure must not block the version's
		// terminal-state write. Log for operator forensics; the
		// next worker sweep will retry on the same pack row.
		const message = err instanceof Error ? err.message : String(err)
		process.stderr.write(`[ingest] tier transition failed for ${versionId}: ${message}\n`)
	}
}

/**
 * Records the tarball artifact for the version. UPSERT semantics:
 * a re-run of the ingest job (which cannot happen because the claim
 * UPDATE pins the row to `ingesting`, but worth defending against
 * future bugs) leaves the existing artifact row alone.
 */
async function recordArtifact(pglite: PGlite, input: ArtifactInput): Promise<void> {
	await pglite.query(
		`INSERT INTO artifacts (version_id, kind, path, size, sha256)
		   VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (version_id, kind, path) DO UPDATE
		   SET size = EXCLUDED.size,
		       sha256 = EXCLUDED.sha256`,
		[input.versionId, input.kind, input.storageKey, input.size, input.contentHash],
	)
}

function stripV(value: string): string {
	return value.startsWith("v") ? value.slice(1) : value
}

/**
 * Static-scan failure branch. Writes the failure row, then throws
 * `IngestFailure` so the worker wrapper marks the version failed
 * with the diagnostic. No dry-run is invoked when the static scan
 * failed — the dry_run field carries the skip reason.
 *
 * Tier transition (VAL-SCAN-008 / 011 / 018, VAL-CROSS-013): a
 * failed static scan marks the pack's tier `community-unverified`
 * so the catalog surfaces the honest verdict. The transition is
 * applied BEFORE the throw so the read surface's tier field is
 * correct even if the wrapper's markFailed write is interrupted
 * (the tier is a separate UPDATE; the version-row update is the
 * wrapper's job).
 */
async function runScreeningFailureStep(
	pglite: PGlite,
	versionId: string,
	result: Awaited<ReturnType<typeof runStaticScan>>,
	packId: string,
): Promise<never> {
	await writeScreeningResult(pglite, versionId, {
		verdict: "failed",
		staticScan: result,
		dryRun: {
			skipped: true,
			reason: "static_scan_failed",
			at: new Date().toISOString(),
		},
	})
	await updatePackTierForVerdict(pglite, packId, "failed")
	const findingsText = result.findings
		.slice(0, 5)
		.map((f: StaticScanFinding) => `${f.capability}@${f.file}:${f.line}`)
		.join("; ")
	const moreCount = Math.max(0, result.findings.length - 5)
	const summary = `${result.summary}${moreCount > 0 ? ` (+${moreCount} more)` : ""}`
	throw new IngestFailure("screening", `${summary}: ${findingsText}`)
}

/**
 * Sandboxed dry-run step (architecture §4.6 layer 2, VAL-SCAN-003
 * / 013 / 014). Runs every non-reasoning recipe in its own
 * `node --permission` subprocess and aggregates the per-recipe
 * outcomes into a verdict transition on `screening_results`:
 *
 *   - ok: true                              → verdict `screened` IF
 *                                            layer 3 also passes;
 *                                            otherwise layer 3 runs
 *                                            and decides the verdict.
 *                                            If layer 3 is skipped
 *                                            (no pack validators,
 *                                            no per-recipe writes
 *                                            outside patterns, no
 *                                            declared toolchain),
 *                                            the dry-run alone
 *                                            upgrades the verdict to
 *                                            `screened`.
 *   - ok: false, reason: 'timeout'         → verdict `unverified`,
 *                                            `dry_run.timedOutAt`
 *                                            recorded, row continues
 *                                            to pack. NO
 *                                            `IngestFailure` thrown
 *                                            — the contract says
 *                                            timeout does NOT fail
 *                                            the version. Layer 3 is
 *                                            NOT invoked (the
 *                                            per-recipe preview files
 *                                            are not durable after a
 *                                            timeout).
 *   - ok: false, reason: 'failure'         → verdict `failed`,
 *                                            `IngestFailure` thrown
 *                                            so the wrapper marks
 *                                            the row failed with
 *                                            the recipe's error
 *                                            message as the
 *                                            diagnostic.
 *
 * The `policy` field on `dry_run` is the own-tree-only statement
 * (VAL-SCAN-014): the recipe's runtime NEVER fetched or installed
 * manifest dependencies; any attempt to import outside the
 * pack's own tree was reported honestly as a per-recipe
 * `failed` result (the sandbox enforcement is the `--permission`
 * flags; the policy text is the user-facing commitment).
 */
async function runDryRunStep(
	deps: IngestDeps,
	versionId: string,
	packDir: string,
	manifest: PackManifest,
	staticResult: Awaited<ReturnType<typeof runStaticScan>>,
	packId: string,
): Promise<void> {
	const result = await runDryRun({
		packDir,
		manifest,
		storage: deps.storage,
		versionId,
		pglite: deps.pglite,
		timeoutMs: deps.screenDryRunTimeoutMs,
	})
	await applyDryRunVerdict(deps, versionId, packDir, manifest, staticResult, result, packId)
}

/**
 * UPSERTs the screening_results row with the dry-run verdict and
 * either returns (screened / unverified) or throws IngestFailure
 * (failed). On a clean dry-run (ok: true), layer 3 runs next; if
 * layer 3 also passes, the verdict becomes `screened`. If layer 3
 * fails, the verdict becomes `failed` and the worker wrapper marks
 * the row failed with the layer-3 failure's honest message.
 *
 * Tier transition (VAL-SCAN-008 / 011 / 018): every verdict
 * transition applies the matching tier update
 * (`community-screened` on a clean dry-run, `community-unverified`
 * on timeout or failure). The helper only updates the row when
 * the current tier is in the community pair — `official` /
 * `verified` rows are left alone by design.
 */
async function applyDryRunVerdict(
	deps: IngestDeps,
	versionId: string,
	packDir: string,
	manifest: PackManifest,
	staticResult: Awaited<ReturnType<typeof runStaticScan>>,
	result: DryRunResult,
	packId: string,
): Promise<void> {
	// Build the discriminated `dry_run` payload. Both branches
	// carry the same fields; the failure branch's `timedOutAt` is
	// included unconditionally because it is required for the
	// VAL-SCAN-013 verdict text (the worker always sets it).
	const completedPayload: {
		policy: string
		perRecipe: DryRunResult["perRecipe"]
		timeoutMs: number
		timedOutAt?: string
	} = {
		policy: result.policy,
		perRecipe: result.perRecipe,
		timeoutMs: result.timeoutMs,
	}
	if (!result.ok) {
		completedPayload.timedOutAt = result.timedOutAt
	}

	if (!result.ok) {
		if (result.reason === "timeout") {
			// Timeout → verdict `unverified`, NO IngestFailure.
			// The worker wrapper leaves the row to continue to
			// pack (`ready`); the verdict text honestly states
			// the dry-run could not complete in time. Layer 3 is
			// NOT invoked (the per-recipe preview files are not
			// durable after a timeout — the subprocess was
			// SIGKILLed before its write list was reported).
			// Tier transition: `unverified` for community
			// packs so the catalog badge reflects the honest
			// "dry-run did not complete" state (VAL-SCAN-011).
			await writeScreeningResult(deps.pglite, versionId, {
				verdict: "unverified",
				staticScan: staticResult,
				dryRun: completedPayload,
			})
			await updatePackTierForVerdict(deps.pglite, packId, "unverified")
			return
		}

		// Failure → verdict `failed`, throw so the wrapper marks
		// the row failed with the diagnostic. The dry_run field
		// carries the per-recipe error for the read surface to
		// surface. Tier transition: `community-unverified` so
		// the catalog surfaces the honest verdict (VAL-SCAN-008,
		// VAL-CROSS-013).
		await writeScreeningResult(deps.pglite, versionId, {
			verdict: "failed",
			staticScan: staticResult,
			dryRun: completedPayload,
		})
		await updatePackTierForVerdict(deps.pglite, packId, "failed")

		const failedRecipes = result.perRecipe.filter((p) => p.status === "failed")
		const firstFailure = failedRecipes[0]
		const errorSummary = firstFailure
			? `dry-run recipe '${firstFailure.recipeId}' failed: ${firstFailure.error}`
			: "dry-run failed for at least one recipe"

		const packName = manifest.name ?? "pack"
		throw new IngestFailure("screening", `${errorSummary} (pack '${packName}')`)
	}

	// ok: true — dry-run passed. Run layer 3 (output validation)
	// against the rendered per-recipe output. Layer 3's verdict
	// decides the overall `screened` / `failed` transition.
	await runOutputValidationStep(deps, versionId, packDir, manifest, staticResult, completedPayload, packId)
}

/**
 * Screening layer 3 (architecture §4.6, VAL-SCAN-006 / 007 /
 * 017). Runs the pack's own validators against the dry-run
 * output, enforces that actual writes ⊆ declared filePatterns,
 * and runs the declared output toolchain (currently `tsc
 * --noEmit` for TS scaffolds). The dry-run step left the
 * per-recipe preview files in the storage adapter; layer 3
 * materializes them into a fresh validation dir and runs the
 * three sub-layers against it.
 *
 * Verdict transitions (VAL-SCAN-008 / 011):
 *   - layer 3 ok → verdict `screened` (overall) + tier
 *     `community-screened` for community packs. The tier
 *     transition is the read-side contract that surfaces the
 *     "pack passed all three layers" badge to the catalog.
 *   - layer 3 fails → verdict `failed`, throws IngestFailure so
 *     the worker wrapper records the row's honest diagnostic;
 *     tier `community-unverified` for community packs so the
 *     catalog surfaces the honest verdict.
 *
 * The `output_validation` jsonb column carries the discriminated
 * payload so the read surface can render the verdict text
 * (which sub-layer failed + the surfaced failure message).
 */
async function runOutputValidationStep(
	deps: IngestDeps,
	versionId: string,
	packDir: string,
	manifest: PackManifest,
	staticResult: Awaited<ReturnType<typeof runStaticScan>>,
	dryRunPayload: {
		policy: string
		perRecipe: DryRunResult["perRecipe"]
		timeoutMs: number
		timedOutAt?: string
	},
	packId: string,
): Promise<void> {
	const outputValidation = await runOutputValidation({
		packDir,
		manifest,
		perRecipe: dryRunPayload.perRecipe,
		storage: deps.storage,
	})

	if (outputValidation.ok) {
		await writeScreeningResult(deps.pglite, versionId, {
			verdict: "screened",
			staticScan: staticResult,
			dryRun: dryRunPayload,
			outputValidation,
		})
		await updatePackTierForVerdict(deps.pglite, packId, "screened")
		return
	}

	// Failure → write the screening_results row with verdict
	// `failed` + the discriminated output_validation payload,
	// then throw so the wrapper marks the row failed with the
	// honest message. Tier transition: `community-unverified`
	// for community packs (VAL-SCAN-011 — failed screening
	// marks the version honestly and the catalog never hides
	// the failure).
	await writeScreeningResult(deps.pglite, versionId, {
		verdict: "failed",
		staticScan: staticResult,
		dryRun: dryRunPayload,
		outputValidation,
	})
	await updatePackTierForVerdict(deps.pglite, packId, "failed")

	const packName = manifest.name ?? "pack"
	throw new IngestFailure("screening", `${outputValidation.failure.message} (pack '${packName}')`)
}

function resolvePackDir(cloneDir: string, packPath: string | null): string {
	if (!packPath) return cloneDir
	// Normalize: reject `..` paths and absolute paths so a malicious
	// publish body cannot escape the clone dir.
	if (packPath.includes("..") || packPath.startsWith("/")) {
		throw new IngestFailure("manifest", `packPath '${packPath}' contains an invalid path segment`)
	}
	return joinSafe(cloneDir, packPath)
}

function joinSafe(base: string, sub: string): string {
	// Simple concat — the validation above already rejects `..` and
	// absolute paths. Node's path.join will still collapse leading
	// `/` in `sub`, so the explicit check above is the actual
	// defense.
	if (sub.length === 0) return base
	const left = base.endsWith("/") ? base : `${base}/`
	return `${left}${sub}`
}
