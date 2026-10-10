// ---------------------------------------------------------------------------
// Consistency test sandbox. Sets up a temp project that symlinks the
// pack under test, runs the 5x consistency test there, and cleans up.
// ---------------------------------------------------------------------------

import { mkdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ConsistencyResult, runConsistencyTest } from "@repo/ast-tooling"
import { loadSession } from "@repo/pack-management-workflow"

import { renderConsistencyResult } from "./render"

interface RunConsistencyArgs {
	n: number
	intent: string
	packName: string
	packDir: string
	cwd: string
}

interface RunConsistencyResult {
	passed: boolean
	artifactDir: string
	summary: string
}

export async function runConsistencyInSandbox(args: RunConsistencyArgs): Promise<RunConsistencyResult> {
	const sandbox = createPackSandbox({
		packName: args.packName,
		packDir: args.packDir,
		cwd: args.cwd,
	})
	try {
		const state = loadSession(args.packDir)
		const recipeId = state?.designedRecipes?.[0]?.id
		if (!recipeId) {
			return { passed: false, artifactDir: "", summary: "no designed recipes in state" }
		}
		let result: ConsistencyResult
		try {
			result = await runConsistencyTest({
				cwd: sandbox.tempDir,
				packName: args.packName,
				recipeId,
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

export function createPackSandbox(args: { packName: string; packDir: string; cwd: string }): {
	tempDir: string
	cleanup: () => void
} {
	const tempDir = join(tmpdir(), `baka-design-${args.packName}-${Date.now()}`)
	mkdirSync(join(tempDir, ".baka", "packs"), { recursive: true })
	symlinkSync(args.packDir, join(tempDir, ".baka", "packs", args.packName), "dir")
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
