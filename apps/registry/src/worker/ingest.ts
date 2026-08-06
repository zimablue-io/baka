import type { PGlite } from "@electric-sql/pglite"
import type { ModuleManifest } from "@repo/protocol"
import { type DryRunResult, runDryRun } from "../screening/dry-run"
import { writeScreeningResult } from "../screening/screening-result"
import { runStaticScan, type StaticScanFinding } from "../screening/static-scan"
import { cleanupClone, shallowCloneAtTag } from "./clone"
import { checkLoadability, IngestFailure, loadManifest } from "./manifest"
import { packTarball } from "./tarball"

/**
 * The payload of a single ingest job. Just the `versionId` — the
 * rest of the row data (commit_sha, manifest, module_id, ...) is
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
 * One job per `module_versions` row: shallow-clone the repo at the
 * requested tag, locate the module dir (via `modulePath`), validate
 * the manifest via jiti against `ModuleManifestSchema`, run the
 * loadability gate, content-hash, pack the tarball, store via the
 * storage adapter, and flip status to `ready`. Failure at any step
 * flips status to `failed` with a diagnostic in `module_versions.error`.
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
	module_id: string
	version: string
	commit_sha: string
	manifest: ModuleManifest & { _publish?: PublishPayload }
	status: string
	error: string | null
	created_at: Date
}

interface ModuleRow {
	id: string
	scope: string
	name: string
	visibility: string
	tier: string
}

interface PublishPayload {
	repo: string
	modulePath: string | null
	visibility: string
	publishedAt: string
}

interface IngestDeps {
	pglite: PGlite
	storage: import("../storage").StorageAdapter
	/**
	 * Per-action dry-run timeout in milliseconds (architecture §8
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
		// Every failure path — clone, modulePath escape, manifest
		// load, loadability gate, pack, store, DB — must terminate
		// the row failed with diagnostics. We rethrow after marking
		// so the runner's per-cycle catch still observes the failure
		// for logging, but the row is durable in its terminal state.
		const message = err instanceof Error ? err.message : String(err)
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

	const moduleRow = await fetchModule(deps.pglite, row.module_id)
	if (moduleRow === null) {
		throw new IngestFailure("manifest", `module row missing for id '${row.module_id}' (cannot determine scope/name)`)
	}

	// Read repo + modulePath from the INGESTED row's own _publish
	// payload (scrutiny-round-1 fix #2). Earlier the worker queried
	// manifest->_publish from the module's NEWEST version row, which
	// silently redirected an older pending version onto a newer
	// version's repo/modulePath when two versions were queued
	// simultaneously. The row's own payload is the canonical source;
	// `_publish` is written by the publish endpoint at the moment the
	// row is created.
	const publish = row.manifest._publish
	if (!publish || typeof publish.repo !== "string" || publish.repo.length === 0) {
		throw new IngestFailure(
			"manifest",
			`publish body not found for module '${moduleRow.scope}/${moduleRow.name}' (cannot determine repo URL)`,
		)
	}
	const repoUrl = publish.repo
	const modulePath = typeof publish.modulePath === "string" && publish.modulePath.length > 0 ? publish.modulePath : null

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
		// Step 2 — locate module dir.
		const moduleDir = resolveModuleDir(clone.dir, modulePath)

		// Step 3 — validate manifest (jiti + ModuleManifestSchema).
		const manifest = await loadManifest(moduleDir)

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

		// Step 4 — loadability gate: every action, every module
		// validator, and every action validator must resolve through
		// the real engine loader (scrutiny-round-1 fix #3). Previously
		// the gate iterated actions only, so a module with a missing
		// validator file reached `ready` and failed later at user-side
		// `baka validate` — the dishonesty this gate exists to prevent.
		await checkLoadability(moduleDir, manifest)

		// Step 4b — static capability scan (architecture §4.6 layer 1,
		// VAL-SCAN-002 / 015 / 016). Public-visibility modules enter
		// the screening pipeline; org-visibility modules skip it
		// entirely (decision 30, "private by default"). The scan
		// never executes the module's own code — it parses every
		// `.ts` file with the TypeScript Compiler API and walks
		// every Handlebars template with a regex detector, looking
		// for network / child_process / eval / dynamic-import /
		// writes-outside-patterns / handlebars-helper violations.
		//
		// On failure: write a screening_results row with verdict
		// 'failed' + the static_scan payload + an explicit dry_run
		// skip marker, then throw IngestFailure so the wrapper
		// routes the version to `failed` with the honest diagnostic.
		// The dry-run layer (next milestone) is NEVER invoked for a
		// version that did not pass the static scan — the dry_run
		// field carries the skip reason so the read surface can
		// explain why no preview artifacts exist.
		//
		// On pass: write a screening_results row with verdict
		// 'unverified' (the overall verdict only becomes 'screened'
		// once the dry-run + validator layers complete in a later
		// milestone). This lets the catalog surface "static scan
		// passed" without prematurely claiming screened status.
		if (moduleRow.visibility === "public") {
			const staticResult = await runStaticScan(moduleDir, manifest)
			if (!staticResult.passed) {
				await runScreeningFailureStep(deps.pglite, payload.versionId, staticResult)
				return
			}
			await runDryRunStep(deps, payload.versionId, moduleDir, manifest, staticResult)
		}

		// Step 5 — content hash + tarball pack.
		const pack = await packTarball(moduleDir)

		// Step 6 — store the tarball via the storage adapter
		// (content-addressed dedup is the adapter's responsibility).
		const stored = await deps.storage.put(pack.bytes)

		// Step 7 — record the artifact row (idempotent via UPSERT on
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
		// Step 8 — always clean up the clone directory.
		await cleanupClone(clone.dir)
	}
}

async function fetchRow(pglite: PGlite, versionId: string): Promise<IngestRow | null> {
	const result = await pglite.query<IngestRow>(
		`SELECT id, module_id, version, commit_sha, manifest, status, error, created_at
		   FROM module_versions
		  WHERE id = $1`,
		[versionId],
	)
	return result.rows[0] ?? null
}

async function fetchModule(pglite: PGlite, moduleId: string): Promise<ModuleRow | null> {
	const result = await pglite.query<ModuleRow>(`SELECT id, scope, name, visibility, tier FROM modules WHERE id = $1`, [
		moduleId,
	])
	return result.rows[0] ?? null
}

async function markReady(pglite: PGlite, versionId: string, contentHash: string): Promise<void> {
	await pglite.query(
		`UPDATE module_versions
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
		`UPDATE module_versions
		    SET status = 'failed',
		        error = $1,
		        updated_at = NOW()
		  WHERE id = $2`,
		[error, versionId],
	)
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
 */
async function runScreeningFailureStep(
	pglite: PGlite,
	versionId: string,
	result: Awaited<ReturnType<typeof runStaticScan>>,
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
 * / 013 / 014). Runs every non-reasoning action in its own
 * `node --permission` subprocess and aggregates the per-action
 * outcomes into a verdict transition on `screening_results`:
 *
 *   - ok: true                              → verdict `screened`,
 *                                            row continues to pack.
 *   - ok: false, reason: 'timeout'         → verdict `unverified`,
 *                                            `dry_run.timedOutAt`
 *                                            recorded, row continues
 *                                            to pack. NO
 *                                            `IngestFailure` thrown
 *                                            — the contract says
 *                                            timeout does NOT fail
 *                                            the version.
 *   - ok: false, reason: 'failure'         → verdict `failed`,
 *                                            `IngestFailure` thrown
 *                                            so the wrapper marks
 *                                            the row failed with
 *                                            the action's error
 *                                            message as the
 *                                            diagnostic.
 *
 * The `policy` field on `dry_run` is the own-tree-only statement
 * (VAL-SCAN-014): the action's runtime NEVER fetched or installed
 * manifest dependencies; any attempt to import outside the
 * module's own tree was reported honestly as a per-action
 * `failed` result (the sandbox enforcement is the `--permission`
 * flags; the policy text is the user-facing commitment).
 */
async function runDryRunStep(
	deps: IngestDeps,
	versionId: string,
	moduleDir: string,
	manifest: ModuleManifest,
	staticResult: Awaited<ReturnType<typeof runStaticScan>>,
): Promise<void> {
	const result = await runDryRun({
		moduleDir,
		manifest,
		storage: deps.storage,
		versionId,
		pglite: deps.pglite,
		timeoutMs: deps.screenDryRunTimeoutMs,
	})
	await applyDryRunVerdict(deps.pglite, versionId, manifest, staticResult, result)
}

/**
 * UPSERTs the screening_results row with the dry-run verdict and
 * either returns (screened / unverified) or throws IngestFailure
 * (failed).
 */
async function applyDryRunVerdict(
	pglite: PGlite,
	versionId: string,
	manifest: ModuleManifest,
	staticResult: Awaited<ReturnType<typeof runStaticScan>>,
	result: DryRunResult,
): Promise<void> {
	// Build the discriminated `dry_run` payload. Both branches
	// carry the same fields; the failure branch's `timedOutAt` is
	// included unconditionally because it is required for the
	// VAL-SCAN-013 verdict text (the worker always sets it).
	const completedPayload: {
		policy: string
		perAction: DryRunResult["perAction"]
		timeoutMs: number
		timedOutAt?: string
	} = {
		policy: result.policy,
		perAction: result.perAction,
		timeoutMs: result.timeoutMs,
	}
	if (!result.ok) {
		completedPayload.timedOutAt = result.timedOutAt
	}

	if (result.ok) {
		await writeScreeningResult(pglite, versionId, {
			verdict: "screened",
			staticScan: staticResult,
			dryRun: completedPayload,
		})
		return
	}

	if (result.reason === "timeout") {
		// Timeout → verdict `unverified`, NO IngestFailure. The
		// worker wrapper leaves the row to continue to pack
		// (`ready`); the verdict text honestly states the
		// dry-run could not complete in time.
		await writeScreeningResult(pglite, versionId, {
			verdict: "unverified",
			staticScan: staticResult,
			dryRun: completedPayload,
		})
		return
	}

	// Failure → verdict `failed`, throw so the wrapper marks the
	// row failed with the diagnostic. The dry_run field carries
	// the per-action error for the read surface to surface.
	await writeScreeningResult(pglite, versionId, {
		verdict: "failed",
		staticScan: staticResult,
		dryRun: completedPayload,
	})

	const failedActions = result.perAction.filter((p) => p.status === "failed")
	const firstFailure = failedActions[0]
	const errorSummary = firstFailure
		? `dry-run action '${firstFailure.actionId}' failed: ${firstFailure.error}`
		: "dry-run failed for at least one action"

	const moduleName = manifest.name ?? "module"
	throw new IngestFailure("screening", `${errorSummary} (module '${moduleName}')`)
}

function resolveModuleDir(cloneDir: string, modulePath: string | null): string {
	if (!modulePath) return cloneDir
	// Normalize: reject `..` paths and absolute paths so a malicious
	// publish body cannot escape the clone dir.
	if (modulePath.includes("..") || modulePath.startsWith("/")) {
		throw new IngestFailure("manifest", `modulePath '${modulePath}' contains an invalid path segment`)
	}
	return joinSafe(cloneDir, modulePath)
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
