import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Consistency test
//
// Drives the full plan+apply loop N times for the same intent and asserts
// that the produced file tree, plan structure, and per-file SHA-256 hashes
// are identical across runs.
//
// Why this matters: a module's contract is "if the LLM plans an action with
// these params, the action will produce these files with these contents".
// If the action's body has a non-deterministic bug, the LLM might plan it
// successfully but the run can drift across invocations. We catch that
// drift at module creation time so the user sees the problem while they
// still have context.
// ---------------------------------------------------------------------------

export interface ConsistencyOptions {
	cwd: string
	moduleName: string
	actionId: string
	intent: string
	n: number
	// Override the baka binary path (default: `baka` on PATH).
	bakaBin?: string
	// Override the path to a custom baka modules root (default: project root).
	projectRoot?: string
}

export interface PerRunResult {
	runIndex: number
	planSteps: number
	planActions: string[]
	planParams: Record<string, unknown>
	files: string[]
	fileHashes: Record<string, string>
	applyExitCode: number
	applyOutput: string
	durationMs: number
}

export interface ConsistencyResult {
	passed: boolean
	moduleName: string
	actionId: string
	intent: string
	n: number
	perRun: PerRunResult[]
	// Divergences between runs (filled only when passed: false).
	divergences: string[]
	// Where the test artefacts (the N per-run scratch dirs) were written.
	artifactDir: string
}

interface RunResult {
	runIndex: number
	planSteps: number
	planActions: string[]
	planParams: Record<string, unknown>
	files: string[]
	fileHashes: Record<string, string>
	applyExitCode: number
	applyOutput: string
	durationMs: number
}

export async function runConsistencyTest(opts: ConsistencyOptions): Promise<ConsistencyResult> {
	const projectRoot = opts.projectRoot ?? opts.cwd
	const bakaBin = opts.bakaBin ?? "baka"
	const n = Math.max(1, opts.n)
	const artifactDir = join(tmpdir(), `baka-consistency-${opts.moduleName}-${Date.now()}`)
	mkdirSync(artifactDir, { recursive: true })

	const perRun: RunResult[] = []
	for (let i = 0; i < n; i++) {
		const runDir = join(artifactDir, `run-${i}`)
		mkdirSync(runDir, { recursive: true })
		const start = Date.now()
		const result = await runOnce({
			runIndex: i,
			runDir,
			projectRoot,
			bakaBin,
			moduleName: opts.moduleName,
			actionId: opts.actionId,
			intent: opts.intent,
		})
		perRun.push({ ...result, durationMs: Date.now() - start })
	}

	const divergences = computeDivergences(perRun)
	const result: ConsistencyResult = {
		passed: divergences.length === 0,
		moduleName: opts.moduleName,
		actionId: opts.actionId,
		intent: opts.intent,
		n,
		perRun,
		divergences,
		artifactDir,
	}
	writeConsistencyTrace(result)
	return result
}

interface RunOnceArgs {
	runIndex: number
	runDir: string
	projectRoot: string
	bakaBin: string
	moduleName: string
	actionId: string
	intent: string
}

async function runOnce(args: RunOnceArgs): Promise<RunResult> {
	const { runIndex, runDir, projectRoot, bakaBin, moduleName, actionId, intent } = args

	// 1. plan
	const planJson = await runBakaPlan(bakaBin, projectRoot, intent, runDir)
	let planSteps = 0
	let planActions: string[] = []
	let planParams: Record<string, unknown> = {}
	try {
		const parsed = JSON.parse(planJson) as { resolvedSteps?: Array<{ module?: string; action?: string; params?: Record<string, unknown> }> }
		planSteps = parsed.resolvedSteps?.length ?? 0
		planActions = (parsed.resolvedSteps ?? []).map((s) => `${s.module ?? "?"}:${s.action ?? "?"}`)
		planParams = (parsed.resolvedSteps ?? []).find((s) => s.module === moduleName && s.action === actionId)?.params ?? {}
	} catch {
		/* leave defaults */
	}

	// 2. apply
	const { exitCode, output } = await runBakaApply(bakaBin, projectRoot, planJson, runDir)

	// 3. Walk the runDir for produced files and hash them
	const { files, hashes } = hashTree(runDir)

	return {
		runIndex,
		planSteps,
		planActions,
		planParams,
		files: files.sort(),
		fileHashes: hashes,
		applyExitCode: exitCode,
		applyOutput: output,
		durationMs: 0, // filled by caller
	}
}

async function runBakaPlan(bakaBin: string, projectRoot: string, intent: string, runDir: string): Promise<string> {
	const out = await exec(bakaBin, ["plan", intent, "--cwd", projectRoot, "--json"], { cwd: runDir })
	// Save the plan so the apply step can use it.
	const planPath = join(runDir, "plan.json")
	writeFileSync(planPath, out, "utf-8")
	return planPath
}

async function runBakaApply(bakaBin: string, projectRoot: string, planPath: string, runDir: string): Promise<{ exitCode: number; output: string }> {
	const { exitCode, stdout, stderr } = await execWithStderr(bakaBin, ["apply", planPath, "--cwd", projectRoot], { cwd: runDir })
	return { exitCode, output: `${stdout}\n${stderr}` }
}

function exec(cmd: string, args: string[], opts: { cwd: string }): Promise<string> {
	return new Promise((resolveProm, reject) => {
		const child = spawn(cmd, args, { cwd: opts.cwd })
		let out = ""
		let err = ""
		child.stdout.on("data", (d) => {
			out += d.toString()
		})
		child.stderr.on("data", (d) => {
			err += d.toString()
		})
		child.on("exit", (code) => {
			if (code === 0) resolveProm(out)
			else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${err}`))
		})
		child.on("error", reject)
	})
}

function execWithStderr(cmd: string, args: string[], opts: { cwd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolveProm) => {
		const child = spawn(cmd, args, { cwd: opts.cwd })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (d) => {
			stdout += d.toString()
		})
		child.stderr.on("data", (d) => {
			stderr += d.toString()
		})
		child.on("exit", (code) => resolveProm({ exitCode: code ?? 1, stdout, stderr }))
		child.on("error", (e) => resolveProm({ exitCode: 1, stdout, stderr: `${stderr}\n${e.message}` }))
	})
}

function hashTree(root: string): { files: string[]; hashes: Record<string, string> } {
	// Walk the runDir with `find` if available, else fall back to a minimal
	// recursive walk. We exclude the plan.json file itself and the .baka
	// scratch dir (it contains the plan, not the produced module artefacts).
	const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
	const findRes = spawnSync("find", [root, "-type", "f", "!", "-path", "*/.baka/*", "!", "-name", "plan.json"], { encoding: "utf-8" })
	const files = (findRes.stdout || "")
		.split("\n")
		.map((f) => f.trim())
		.filter((f) => f !== "")
	const hashes: Record<string, string> = {}
	for (const f of files) {
		try {
			const content = readFileSync(f)
			hashes[f] = createHash("sha256").update(content).digest("hex")
		} catch {
			hashes[f] = "(unreadable)"
		}
	}
	return { files, hashes }
}

function computeDivergences(perRun: RunResult[]): string[] {
	return computeDivergencesForTest(perRun)
}

// Test-only helpers, exported for vitest. They mirror the private
// computeDivergences / writeConsistencyTrace logic exactly.
export function computeDivergencesForTest(perRun: RunResult[]): string[] {
	if (perRun.length < 2) return []
	const divergences: string[] = []
	const ref = perRun[0] as RunResult

	// Plan actions
	for (let i = 1; i < perRun.length; i++) {
		const r = perRun[i] as RunResult
		if (r.planActions.join("|") !== ref.planActions.join("|")) {
			divergences.push(`run ${i}: plan actions differ. ref=${JSON.stringify(ref.planActions)} got=${JSON.stringify(r.planActions)}`)
		}
		if (JSON.stringify(r.planParams) !== JSON.stringify(ref.planParams)) {
			divergences.push(`run ${i}: plan params differ. ref=${JSON.stringify(ref.planParams)} got=${JSON.stringify(r.planParams)}`)
		}
		if (r.files.join("|") !== ref.files.join("|")) {
			divergences.push(`run ${i}: file tree differs. ref=${JSON.stringify(ref.files)} got=${JSON.stringify(r.files)}`)
		}
		for (const f of ref.files) {
			if (r.fileHashes[f] && r.fileHashes[f] !== ref.fileHashes[f]) {
				divergences.push(`run ${i}: hash mismatch on ${f}. ref=${ref.fileHashes[f]} got=${r.fileHashes[f]}`)
			}
			if (!r.fileHashes[f]) {
				divergences.push(`run ${i}: file ${f} missing`)
			}
		}
	}
	return divergences
}

function writeConsistencyTrace(result: ConsistencyResult): void {
	renderConsistencyTraceForTest(result)
}

export function renderConsistencyTraceForTest(result: ConsistencyResult): void {
	const tracePath = join(result.artifactDir, "CONSISTENCY-TRACE.json")
	const lines: string[] = [
		`# Consistency trace for ${result.moduleName}:${result.actionId}`,
		``,
		`Intent: ${result.intent}`,
		`Runs: ${result.n}`,
		`Result: ${result.passed ? "PASS" : "FAIL"}`,
		``,
	]
	for (const r of result.perRun) {
		lines.push(`## Run ${r.runIndex} (${r.durationMs}ms, apply exit ${r.applyExitCode})`)
		lines.push(`- Plan actions: ${JSON.stringify(r.planActions)}`)
		lines.push(`- Plan params:  ${JSON.stringify(r.planParams)}`)
		lines.push(`- Files (${r.files.length}):`)
		for (const f of r.files) {
			lines.push(`  - ${f}  ${r.fileHashes[f]?.slice(0, 12) ?? "?"}`)
		}
		lines.push(``)
	}
	if (result.divergences.length > 0) {
		lines.push(`## Divergences`)
		for (const d of result.divergences) lines.push(`- ${d}`)
	}
	writeFileSync(tracePath, lines.join("\n"), "utf-8")
	// Also write a JSON copy for machine consumption.
	writeFileSync(join(result.artifactDir, "CONSISTENCY.json"), JSON.stringify(result, null, 2), "utf-8")
}

/**
 * Cleanup helper: rm -rf the artifact dir when the caller is done with it.
 */
export function cleanupConsistency(result: ConsistencyResult): void {
	try {
		if (existsSync(result.artifactDir)) rmSync(result.artifactDir, { recursive: true, force: true })
	} catch {
		/* best effort */
	}
}
