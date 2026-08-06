import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { PGlite } from "@electric-sql/pglite"
import type { ModuleManifest } from "@repo/protocol"
import type { StorageAdapter } from "../storage"
import { DRY_RUN_SCRIPT } from "./dry-run-script"
import { writePreviewRecord } from "./preview-record"

/**
 * Sandboxed dry-run executor (architecture §4.6 layer 2).
 *
 * One subprocess per non-reasoning action. Each subprocess runs
 * `node --permission --allow-fs-read=<module>,<jiti-root>
 *  --allow-fs-write=<sandbox> -e DRY_RUN_SCRIPT --` with the
 * action id / module dir / sandbox dir / jiti root on argv.
 *
 * Per-action outcomes are aggregated into a discriminated
 * `DryRunResult`:
 *
 *   ok: true
 *     Every non-reasoning action either ran successfully
 *     (subprocess reported success: true and produced files)
 *     OR was requiresReasoning: true (recorded as needs-llm).
 *     Reasoning actions never fail the verdict — they get a
 *     needs-llm preview record but the run still screens.
 *
 *   ok: false, reason: 'timeout'
 *     At least one non-reasoning action exceeded the configured
 *     timeout (decision 6, default 60s). The version is marked
 *     `unverified` — the row continues to `ready` so the version
 *     stays installable, but the verdict text honestly states the
 *     dry-run could not complete in time. `timedOutAt` carries the
 *     ISO timestamp of the timeout.
 *
 *   ok: false, reason: 'failure'
 *     At least one non-reasoning action failed (e.g. fs-escape
 *     ERR_ACCESS_DENIED, runtime error inside execute()). The
 *     version is marked `failed` via `IngestFailure` so the worker
 *     wrapper terminates the row.
 *
 * `policy` is the own-tree-only statement that satisfies
 * VAL-SCAN-014. It is the same string for every outcome so the
 * read surface can render a uniform verdict footer regardless of
 * the per-action result mix.
 *
 * Realpath resolution (architecture §9 gotcha): macOS /tmp is a
 * symlink to /private/tmp. The Node `--permission` flag rejects
 * allow paths that resolve through a symlink it cannot follow —
 * `fs.realpathSync` is the documented workaround. We resolve the
 * module dir AND the sandbox dir before passing them to
 * `--allow-fs-*`.
 */

export const OWN_TREE_ONLY_POLICY =
	"screening executes only the module's own tree; manifest dependencies are preserved verbatim and are NOT fetched or installed; any runtime import outside the module's own tree is reported honestly"

export const DEFAULT_DRY_RUN_TIMEOUT_MS = 60_000

export interface PreviewFile {
	path: string
	contentHash: string
	size: number
	storageKey: string
}

export interface PerActionResultScreened {
	actionId: string
	status: "screened"
	needsLlm: false
	previewFiles: PreviewFile[]
}

export interface PerActionResultNeedsLlm {
	actionId: string
	status: "needs-llm"
	needsLlm: true
	reason: string
}

export interface PerActionResultFailed {
	actionId: string
	status: "failed"
	error: string
}

export interface PerActionResultTimedOut {
	actionId: string
	status: "timed-out"
	timedOutAt: string
}

export type PerActionResult =
	| PerActionResultScreened
	| PerActionResultNeedsLlm
	| PerActionResultFailed
	| PerActionResultTimedOut

/**
 * Per-action payload surfaced on `dry_run.perAction` (catalog
 * read surface). Mirrors `PerActionResult` minus the runtime
 * fields the catalog does not need.
 */
export type PerActionState =
	| { actionId: string; status: "screened"; needsLlm: false; previewFiles: PreviewFile[] }
	| { actionId: string; status: "needs-llm"; needsLlm: true; reason: string }
	| { actionId: string; status: "failed"; error: string }
	| { actionId: string; status: "timed-out"; timedOutAt: string }

export interface DryRunResultSuccess {
	ok: true
	policy: string
	perAction: PerActionState[]
	timeoutMs: number
}

export interface DryRunResultFailure {
	ok: false
	reason: "timeout" | "failure"
	policy: string
	perAction: PerActionState[]
	timeoutMs: number
	timedOutAt: string
}

export type DryRunResult = DryRunResultSuccess | DryRunResultFailure

export interface RunDryRunOptions {
	moduleDir: string
	manifest: ModuleManifest
	storage: StorageAdapter
	versionId: string
	pglite: PGlite
	timeoutMs?: number
	/**
	 * Directory jiti uses for resolving workspace imports
	 * (baka-sdk, @repo/protocol, ...). Defaults to the closest
	 * node_modules/ parent walking up from moduleDir, falling
	 * back to process.cwd().
	 *
	 * The directory MUST be readable by the subprocess, so it is
	 * added to `--allow-fs-read`. Production deployments should
	 * pass the registry install root explicitly; the auto-detect
	 * is for dev / test ergonomics.
	 */
	jitiRoot?: string
}

interface SubprocessOutcome {
	kind: "success" | "failed" | "timed-out" | "load-error"
	files?: Array<{ path: string; size: number }>
	error?: string
}

/**
 * Runs the dry-run over every non-reasoning action. Reasoning
 * actions (`requiresReasoning: true`) are recorded as `needs-llm`
 * but never executed. The verdict is `ok: true` when every
 * non-reasoning action succeeded; `ok: false` otherwise.
 *
 * Spawn isolation (architecture §4.6): each action gets its own
 * subprocess AND its own sandbox dir. A failure in one action's
 * `execute()` cannot pollute another action's preview state, and
 * a runaway subprocess is killed without affecting the other
 * actions in the run.
 */
export async function runDryRun(opts: RunDryRunOptions): Promise<DryRunResult> {
	const policy = OWN_TREE_ONLY_POLICY
	const timeoutMs = opts.timeoutMs ?? DEFAULT_DRY_RUN_TIMEOUT_MS
	const moduleReal = realpathSync(opts.moduleDir)
	const jitiRootReal = realpathSync(opts.jitiRoot ?? findJitiRoot(opts.moduleDir))

	const perAction: PerActionState[] = []
	let timeoutStamp: string | undefined
	let overallReason: "timeout" | "failure" | null = null

	for (const action of opts.manifest.actions) {
		if (action.requiresReasoning) {
			const result: PerActionResultNeedsLlm = {
				actionId: action.id,
				status: "needs-llm",
				needsLlm: true,
				reason: "action skipped because it requires LLM reasoning",
			}
			perAction.push(toState(result))
			await writePreviewRecord(opts.pglite, result, opts.versionId)
			continue
		}

		const sandboxDir = await mkdtemp(join(tmpdir(), "baka-dryrun-"))
		const sandboxReal = realpathSync(sandboxDir)
		for (const pattern of action.filePatterns ?? []) {
			const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "")
			const lastSlash = normalized.lastIndexOf("/")
			const looksLikeDirectory = normalized.endsWith("/") || !normalized.split("/").at(-1)?.includes(".")
			const directory = looksLikeDirectory ? normalized : normalized.slice(0, lastSlash)
			if (directory.length > 0) mkdirSync(join(sandboxReal, directory), { recursive: true })
		}
		try {
			const outcome = await runOneAction({
				actionId: action.id,
				moduleReal,
				jitiRootReal,
				sandboxReal,
				timeoutMs,
			})

			if (outcome.kind === "success") {
				const previewFiles: PreviewFile[] = []
				for (const file of outcome.files ?? []) {
					const fullPath = join(sandboxReal, file.path)
					try {
						const content = await readFile(fullPath)
						const stored = await opts.storage.put(content)
						previewFiles.push({
							path: file.path,
							contentHash: stored.sha256,
							size: stored.size,
							storageKey: stored.key,
						})
					} catch {
						// Per-file read failure: skip silently. The
						// parent does not need every byte; it only
						// needs the surfaced preview list to match
						// what the action successfully wrote.
					}
				}
				const result: PerActionResultScreened = {
					actionId: action.id,
					status: "screened",
					needsLlm: false,
					previewFiles,
				}
				perAction.push(toState(result))
				await writePreviewRecord(opts.pglite, result, opts.versionId)
			} else if (outcome.kind === "timed-out") {
				const stamp = new Date().toISOString()
				timeoutStamp = stamp
				const result: PerActionResultTimedOut = {
					actionId: action.id,
					status: "timed-out",
					timedOutAt: stamp,
				}
				perAction.push(toState(result))
				await writePreviewRecord(opts.pglite, result, opts.versionId)
				if (overallReason === null) overallReason = "timeout"
			} else {
				// 'failed' or 'load-error' — both surface as
				// per-action `failed` so the verdict becomes
				// `failed`. Load errors (jiti throw, missing
				// action.ts, unresolved export) are the registry's
				// view of the action, not the action's own fault,
				// but the verdict is still `failed` because the
				// action did not produce a usable preview.
				const result: PerActionResultFailed = {
					actionId: action.id,
					status: "failed",
					error: outcome.error ?? "dry-run subprocess failed",
				}
				perAction.push(toState(result))
				await writePreviewRecord(opts.pglite, result, opts.versionId)
				if (overallReason === null) overallReason = "failure"
			}
		} finally {
			// Cleanup on every path (success / failure / timeout).
			// The subprocess has already exited by the time we
			// reach this block — the `close` event reaped it and
			// released its file handles — so rmSync is safe.
			try {
				rmSync(sandboxDir, { recursive: true, force: true })
			} catch {
				// Cleanup is best-effort; a leftover sandbox dir is
				// cosmetic, not a correctness issue.
			}
		}
	}

	if (overallReason === "failure") {
		return {
			ok: false,
			reason: "failure",
			policy,
			perAction,
			timeoutMs,
			timedOutAt: timeoutStamp ?? new Date().toISOString(),
		}
	}
	if (overallReason === "timeout") {
		return {
			ok: false,
			reason: "timeout",
			policy,
			perAction,
			timeoutMs,
			timedOutAt: timeoutStamp ?? new Date().toISOString(),
		}
	}
	return { ok: true, policy, perAction, timeoutMs }
}

/**
 * Spawns the dry-run subprocess for a single action and waits for
 * its JSON envelope on stdout. The subprocess is SIGKILL'd on
 * timeout; the parent waits for the `close` event before returning
 * so no orphan `node --permission` child survives.
 *
 * The implementation uses `spawn` directly (rather than
 * `execFile` + promisify) so we have a real `ChildProcess`
 * handle with `stdout` / `stderr` streams we can subscribe to
 * AND a `kill()` method for the SIGKILL-on-timeout path. The
 * promisified execFile returns the resolved stdout/stderr in
 * the Promise result but does not surface the underlying child
 * with a stable type, so the timeout-kill logic was harder to
 * reason about.
 */
function runOneAction(opts: {
	actionId: string
	moduleReal: string
	jitiRootReal: string
	sandboxReal: string
	timeoutMs: number
}): Promise<SubprocessOutcome> {
	return new Promise((resolve) => {
		// Node 24 dropped support for comma-separated `--allow-fs-read`
		// (a deprecation warning is emitted, and the paths are
		// silently treated as one literal path that does not match
		// any real directory). Repeat the flag for each path so
		// every real directory is on the read allow list. The
		// sandbox dir is included on the read allow list because
		// `--allow-fs-write` alone is not enough: Node 24 also
		// gates `process.chdir()` and `fs.readdirSync()` under
		// the read scope, so the script can only chdir / walk the
		// sandbox if it can read it too. The action's fs-escape
		// attempts are still blocked because paths outside the
		// allow list are denied.
		//
		// `jitiRoot*` plus the extra paths returned by
		// `jitiReadPaths()` cover everything jiti and any
		// transitive deps need to load: `<dir>/*` lets the
		// permission scope walk descendants; the dir entries
		// themselves are also listed so the bare-dir chdir /
		// existsSync checks succeed on them. See `jitiReadPaths`
		// for the symlink-fallthrough rationale.
		const extraReadPaths = jitiReadPaths()
		const readPaths = [opts.moduleReal, opts.sandboxReal, opts.jitiRootReal, `${opts.jitiRootReal}*`]
		for (const p of extraReadPaths) readPaths.push(p)
		const args: string[] = ["--permission"]
		for (const p of readPaths) {
			args.push(`--allow-fs-read=${p}`)
		}
		args.push(`--allow-fs-write=${opts.sandboxReal}`)
		args.push(
			"-e",
			DRY_RUN_SCRIPT,
			"--",
			"--action-id",
			opts.actionId,
			"--module-dir",
			opts.moduleReal,
			"--sandbox-dir",
			opts.sandboxReal,
			"--jiti-root",
			opts.jitiRootReal,
		)

		let stdoutBuf = ""
		let stderrBuf = ""
		let settled = false
		let timedOut = false

		let child: ChildProcess
		try {
			child = spawn(process.execPath, args, {
				env: { ...process.env, NODE_OPTIONS: "" },
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			resolve({ kind: "load-error", error: `spawn failed: ${message}` })
			return
		}

		const onStdout = (chunk: Buffer): void => {
			stdoutBuf += chunk.toString("utf8")
		}
		const onStderr = (chunk: Buffer): void => {
			stderrBuf += chunk.toString("utf8")
		}
		child.stdout?.on("data", onStdout)
		child.stderr?.on("data", onStderr)

		const timer = setTimeout(() => {
			if (settled) return
			timedOut = true
			try {
				child.kill("SIGKILL")
			} catch {
				// Already dead — that's fine.
			}
		}, opts.timeoutMs)

		child.on("error", (err) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.stdout?.off("data", onStdout)
			child.stderr?.off("data", onStderr)
			resolve({ kind: "load-error", error: `subprocess crashed: ${err.message}` })
		})

		child.on("close", (code, signal) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.stdout?.off("data", onStdout)
			child.stderr?.off("data", onStderr)

			if (timedOut || signal === "SIGKILL" || signal === "SIGTERM") {
				resolve({ kind: "timed-out", error: `dry-run exceeded ${opts.timeoutMs}ms` })
				return
			}
			if (code !== 0 && code !== null) {
				// Hard failure: the script exited non-zero without
				// reporting a soft failure on stdout. Surface the
				// full stderr (no truncation) so the verdict text
				// quotes the actual error.
				const stderr = stderrBuf.length > 0 ? stderrBuf : ""
				resolve({
					kind: "load-error",
					error:
						stderr.length > 0
							? `dry-run subprocess exited with code ${code}: ${stderr}`
							: `dry-run subprocess exited with code ${code}`,
				})
				return
			}

			resolve(parseEnvelope(stdoutBuf, stderrBuf))
		})
	})
}

function parseEnvelope(stdout: string, stderr: string): SubprocessOutcome {
	const trimmed = stdout.trim()
	// The subprocess emits exactly one JSON line on stdout. Find the
	// last newline-terminated JSON object (defensive against any
	// node startup banners that might bleed in).
	let envelopeText: string | null = null
	for (const line of trimmed.split("\n")) {
		const candidate = line.trim()
		if (candidate.startsWith("{") && candidate.endsWith("}")) {
			envelopeText = candidate
		}
	}
	if (envelopeText === null) {
		return {
			kind: "load-error",
			error:
				stderr.length > 0
					? `dry-run subprocess produced no JSON envelope; stderr: ${stderr.slice(0, 500)}`
					: "dry-run subprocess produced no JSON envelope",
		}
	}

	let envelope: { success?: boolean; error?: string; files?: Array<{ path?: string; size?: number }> }
	try {
		envelope = JSON.parse(envelopeText) as typeof envelope
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return { kind: "load-error", error: `dry-run envelope is not valid JSON: ${msg}` }
	}

	if (envelope.success === true) {
		const files: Array<{ path: string; size: number }> = []
		for (const file of envelope.files ?? []) {
			if (typeof file.path === "string" && typeof file.size === "number") {
				files.push({ path: file.path, size: file.size })
			}
		}
		return { kind: "success", files }
	}

	return {
		kind: "failed",
		error:
			typeof envelope.error === "string"
				? envelope.error
				: "dry-run subprocess reported failure without an error message",
	}
}

/**
 * Walks up from `start` looking for the closest `node_modules/`.
 * Returns the parent of `node_modules/` (the directory jiti will
 * use for module resolution) so the subprocess's `--allow-fs-read`
 * includes that path.
 *
 * Returns `process.cwd()` when no `node_modules/` is found within
 * 8 levels — a graceful fallback that lets the subprocess start
 * (it just won't be able to resolve any workspace imports).
 */
function findJitiRoot(start: string): string {
	let cur = start
	for (let i = 0; i < 8; i++) {
		const candidate = join(cur, "node_modules")
		if (existsSync(candidate)) return cur
		const parent = dirname(cur)
		if (parent === cur) break
		cur = parent
	}
	return process.cwd()
}

/**
 * Returns the read-scope paths needed for the dry-run subprocess
 * to be able to load `jiti` and any of its transitive deps.
 *
 * Node 24's `--permission` gates module resolution under the
 * read scope: `require('jiti')` walks up from cwd looking for
 * `node_modules/jiti`, and `readPackageJSON` on the matched
 * `package.json` (plus every `require()` jiti performs) is also
 * gated. A bare `--allow-fs-read=<jitiRoot>` is not enough when
 * `jiti` lives in a parent's `node_modules/` (pnpm hoists, npm
 * dedup), because the resolved entry path is a symlink — for
 * example:
 *
 *     /baka/node_modules/jiti → /baka/node_modules/.pnpm/jiti@x/node_modules/jiti
 *
 * The `readPackageJSON` call inside CommonJS loader walks the
 * resolved path (`…/.pnpm/jiti@x/node_modules/jiti/...`), but
 * Node's permission scope also matches against the symlink path
 * itself when it consults `<pkgRoot>/package.json`. Wildcards
 * in `--allow-fs-read` are not symlink-following: passing only
 * the resolved `.pnpm/jiti@x/*` form fails because Node opens
 * `package.json` through the symlink at `/baka/node_modules/`.
 *
 * The simplest correct strategy is to allow the entire
 * `node_modules/` parent on both sides of the symlink. We
 * resolve `jiti` from THIS module's context (which uses the
 * registry's install path, the same resolution the subprocess
 * will inherit) and walk up the realpath chain to the topmost
 * `node_modules/` ancestor — that is `…/.pnpm/<pkg>@<ver>/`,
 * whose parent is the pnpm virtual store root.
 *
 * We then also resolve the same module without realpath so we
 * can locate the matching un-resolved `node_modules/` (e.g.
 * `/baka/node_modules`) and grant it too. We return two paths
 * per root:
 *
 *   - `<root>` — the dir itself, so bare operations like
 *     `existsSync` work.
 *   - `<root>/*` — covers descendants.
 *
 * Returns an empty array when jiti cannot be resolved (which
 * should never happen — it is a hard dep — but we handle
 * gracefully so the error surface is sensible).
 */
function jitiReadPaths(): string[] {
	try {
		const req = createRequire(import.meta.url)
		// `realpath: false` keeps the symlink path so we can
		// locate the un-resolved `node_modules/` parent. We
		// then realpath afterwards to get the resolved tree.
		const jitiResolved = req.resolve("jiti")
		const jitiReal = realpathSync(jitiResolved)
		const topOfReal = topmostNodeModulesParent(jitiReal)
		const topOfSymlink = topmostNodeModulesParent(jitiResolved)
		const paths = new Set<string>()
		for (const root of [topOfReal, topOfSymlink]) {
			if (!root) continue
			paths.add(root)
			paths.add(`${root}*`)
		}
		return [...paths]
	} catch {
		return []
	}
}

/** Walks up from `start` to the parent of the topmost
 *  `node_modules/` directory. Returns null when none is found. */
function topmostNodeModulesParent(start: string): string | null {
	let cur = start
	let lastNodeModules: string | null = null
	while (true) {
		const parent = dirname(cur)
		if (parent === cur) break
		if (basename(cur) === "node_modules") {
			lastNodeModules = cur
		}
		cur = parent
	}
	if (!lastNodeModules) return null
	return dirname(lastNodeModules)
}

function basename(p: string): string {
	const sep = p.lastIndexOf("/")
	return sep < 0 ? p : p.substring(sep + 1)
}

function toState(result: PerActionResult): PerActionState {
	switch (result.status) {
		case "screened":
			return { actionId: result.actionId, status: "screened", needsLlm: false, previewFiles: result.previewFiles }
		case "needs-llm":
			return { actionId: result.actionId, status: "needs-llm", needsLlm: true, reason: result.reason }
		case "failed":
			return { actionId: result.actionId, status: "failed", error: result.error }
		case "timed-out":
			return { actionId: result.actionId, status: "timed-out", timedOutAt: result.timedOutAt }
	}
}
