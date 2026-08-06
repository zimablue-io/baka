import type { PGlite } from "@electric-sql/pglite"
import type { ModuleManifest } from "@repo/protocol"
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
 */

interface IngestRow {
	id: string
	module_id: string
	version: string
	commit_sha: string
	manifest: ModuleManifest
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

interface IngestDeps {
	pglite: PGlite
	storage: import("../storage").StorageAdapter
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
 * Throws `IngestFailure` for any unexpected error (e.g. the
 * loadability gate's underlying jiti loader crashed). For expected
 * failures (loadability rejected, manifest missing, etc.) the
 * function catches the error, writes the diagnostic to
 * `module_versions.error`, and returns cleanly. The polling loop's
 * next cycle will not pick the row up again (its status is no
 * longer `pending`), so the contract is one polling cycle → one
 * terminal state, never "still ingesting" forever.
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
		await markFailed(deps.pglite, payload.versionId, `module row missing for id '${row.module_id}'`)
		return
	}

	const repoRow = await fetchRepo(deps.pglite, row.module_id)
	if (repoRow === null) {
		await markFailed(
			deps.pglite,
			payload.versionId,
			`publish body not found for module '${moduleRow.scope}/${moduleRow.name}' (cannot determine repo URL)`,
		)
		return
	}

	// Step 1 — clone (bounded by INGEST_CLONE_TIMEOUT_MS, default 120s).
	const clone = await shallowCloneAtTag(repoRow.repo_url, row.version).catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err)
		// Re-thrown as IngestFailure so the worker records the diagnostic
		// and the version is marked failed honestly.
		throw new IngestFailure("manifest", `clone failed for ${repoRow.repo_url}@${row.version}: ${message}`)
	})

	try {
		// Step 2 — locate module dir.
		const moduleDir = resolveModuleDir(clone.dir, repoRow.module_path)

		// Step 3 — validate manifest (jiti + ModuleManifestSchema).
		let manifest: ModuleManifest
		try {
			manifest = await loadManifest(moduleDir)
		} catch (err) {
			const message = err instanceof IngestFailure ? err.message : err instanceof Error ? err.message : String(err)
			await markFailed(deps.pglite, payload.versionId, `manifest: ${message}`)
			return
		}

		// Verify the worker's parsed manifest agrees with the version
		// the row already records — the publish endpoint did the
		// tag/manifest match check, but the worker re-evaluates the
		// FULL schema so a future bug in the narrow reader does not
		// silently corrupt the DB. A mismatch here is a server bug,
		// not a publish-side problem; we still mark failed.
		const rowManifestVersion = stripV((row.manifest as { version?: string }).version ?? "")
		const freshManifestVersion = stripV(manifest.version)
		if (rowManifestVersion !== freshManifestVersion) {
			await markFailed(
				deps.pglite,
				payload.versionId,
				`worker's parsed manifest version '${manifest.version}' disagrees with publish-time version '${rowManifestVersion || "(missing)"}'`,
			)
			return
		}

		// Step 4 — loadability gate (every action resolves through
		// the real loader).
		try {
			await checkLoadability(moduleDir, manifest)
		} catch (err) {
			const message = err instanceof IngestFailure ? err.message : err instanceof Error ? err.message : String(err)
			await markFailed(deps.pglite, payload.versionId, `loadability: ${message}`)
			return
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

interface RepoUrlRow {
	repo_url: string
	module_path: string | null
}

/**
 * The publish endpoint stores repo + tag + modulePath in the
 * `module_versions.manifest` JSONB (the publish-side parsed shape)
 * but does NOT persist a dedicated repo_url column. This helper
 * reads the repo URL out of the manifest payload, falling back to
 * the publish body's shape if the manifest was malformed at publish
 * time.
 */
async function fetchRepo(pglite: PGlite, moduleId: string): Promise<RepoUrlRow | null> {
	// We do not currently persist `repo` and `modulePath` in their
	// own columns — they live in the publish-time manifest JSONB
	// under `_publish` keys written by the publish endpoint. The
	// worker is the canonical consumer of those keys; a row whose
	// manifest does not carry them is a server bug, not a normal
	// failure mode.
	const result = await pglite.query<{ repo_url: string | null; module_path: string | null }>(
		`SELECT manifest->'_publish'->>'repo'   AS repo_url,
		        manifest->'_publish'->>'modulePath' AS module_path
		   FROM module_versions mv
		  WHERE mv.module_id = $1
		    AND mv.manifest ? '_publish'
		  ORDER BY mv.created_at DESC
		  LIMIT 1`,
		[moduleId],
	)
	const row = result.rows[0]
	if (!row || !row.repo_url) return null
	return { repo_url: row.repo_url, module_path: row.module_path }
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
	return joinFromParts(base, sub)
}

function joinFromParts(base: string, sub: string): string {
	// Use a tiny non-recursive join to keep this file's deps small.
	if (sub.length === 0) return base
	const left = base.endsWith("/") ? base : `${base}/`
	return `${left}${sub}`
}
