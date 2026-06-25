// ---------------------------------------------------------------------------
// Consistency test sandbox. Sets up a temp project that symlinks the
// module under test (and the baka-base module it depends on), runs the
// 5x consistency test there, and cleans up. This is what the workflow
// invokes from the DELIVER phase.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DesignSessionState } from "@repo/module-management-workflow"
import { type ConsistencyResult, runConsistencyTest } from "@repo/ast-tooling"

// Minimal inline equivalent of loadSession — avoids tsx ESM static-analysis
// issue when Node can't verify named exports from a .ts package entry.
import { renderConsistencyResult } from "./render"

const STATE_FILE = ".design-state.json"

function loadSession(moduleDir: string): DesignSessionState | null {
	const path = join(moduleDir, STATE_FILE)
	if (!existsSync(path)) return null
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as DesignSessionState
	}
	catch {
		return null
	}
}

export interface RunConsistencyArgs {
	n: number
	intent: string
	moduleName: string
	moduleDir: string
	cwd: string
}

export interface RunConsistencyResult {
	passed: boolean
	artifactDir: string
	summary: string
}

export async function runConsistencyInSandbox(args: RunConsistencyArgs): Promise<RunConsistencyResult> {
	const sandbox = createModuleSandbox({
		moduleName: args.moduleName,
		moduleDir: args.moduleDir,
		cwd: args.cwd,
	})
	try {
		const state = loadSession(args.moduleDir)
		const actionId = state?.designedActions?.[0]?.id
		if (!actionId) {
			return { passed: false, artifactDir: "", summary: "no designed actions in state" }
		}
		let result: ConsistencyResult
		try {
			result = await runConsistencyTest({
				cwd: sandbox.tempDir,
				moduleName: args.moduleName,
				actionId,
				intent: args.intent,
				n: args.n,
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return { passed: false, artifactDir: "", summary: `consistency test threw: ${message}` }
		}
		console.log(renderConsistencyResult(result))
		return { passed: result.passed, artifactDir: result.artifactDir, summary: resultSummary(result) }
	} finally {
		sandbox.cleanup()
	}
}

export function createModuleSandbox(args: { moduleName: string; moduleDir: string; cwd: string }): {
	tempDir: string
	cleanup: () => void
} {
	const tempDir = join(tmpdir(), `baka-design-${args.moduleName}-${Date.now()}`)
	mkdirSync(join(tempDir, ".baka", "modules"), { recursive: true })
	symlinkSync(args.moduleDir, join(tempDir, ".baka", "modules", args.moduleName), "dir")
	symlinkSync(join(args.cwd, "modules", "baka-base"), join(tempDir, "modules", "baka-base"), "dir")
	return {
		tempDir,
		cleanup: () => {
			try {
				rmSync(tempDir, { recursive: true, force: true })
			} catch {
				/* best effort */
			}
		},
	}
}

function resultSummary(result: ConsistencyResult): string {
	return `${result.passed ? "PASS" : "FAIL"} — ${result.n} run(s), ${result.divergences.length} divergence(s)`
}
