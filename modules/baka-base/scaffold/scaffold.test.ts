import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"
import { afterEach, describe, expect, it } from "vitest"
import { Manifest } from "../manifest.js"
import { type ScaffoldCompensationData, type ScaffoldInput, scaffoldAction } from "./action.js"
import { hasConsoleLog } from "./validators/has-console-log.js"

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanup: string[] = []

afterEach(() => {
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-base-scaffold-"))
	cleanup.push(dir)
	return dir
}

function makeState(targetDirectory: string): OrchestrationState {
	return {
		userIntent: "test",
		targetDirectory,
		status: "EXECUTING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	} as OrchestrationState
}

function listTree(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort()
}

function scaffoldFilePatterns(): string[] {
	const action = Manifest.actions.find((a) => a.id === "scaffold")
	if (!action) throw new Error("scaffold action missing from manifest")
	return [...action.filePatterns].sort()
}

async function runScaffold(dir: string, moduleType: "esm" | "commonjs") {
	const input: ScaffoldInput = { name: "probe-project", description: "probe", moduleType }
	const result = await scaffoldAction.execute(input, makeState(dir))
	expect(result.success).toBe(true)
	return result
}

const tscBin = createRequire(import.meta.url).resolve("typescript/bin/tsc")

function runTscNoEmit(dir: string): void {
	// Throws with the compiler output attached when tsc exits non-zero.
	execFileSync(process.execPath, [tscBin, "--noEmit", "-p", dir], { stdio: "pipe" })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("baka-base.scaffold — manifest contract", () => {
	it.each([
		"esm",
		"commonjs",
	] as const)("writes exactly the files its manifest filePatterns declares (%s)", async (moduleType) => {
		const dir = makeTempDir()
		await runScaffold(dir, moduleType)
		expect(listTree(dir)).toEqual(scaffoldFilePatterns())
	})

	it("src/index.ts is a hello-world entry point containing console.log", async () => {
		const dir = makeTempDir()
		await runScaffold(dir, "esm")
		const indexPath = join(dir, "src", "index.ts")
		expect(existsSync(indexPath)).toBe(true)
		expect(readFileSync(indexPath, "utf-8")).toMatch(/console\.log\(/)
	})
})

describe("baka-base.scaffold — own validators pass on its output", () => {
	it("hasConsoleLog returns zero diagnostics on fresh scaffold output", async () => {
		const dir = makeTempDir()
		const result = await runScaffold(dir, "esm")
		const diagnostics = await hasConsoleLog(makeState(dir), result.compensationData as ScaffoldCompensationData)
		expect(diagnostics).toEqual([])
	})
})

describe("baka-base.scaffold — own toolchain passes on its output", () => {
	it.each(["esm", "commonjs"] as const)("tsc --noEmit passes on the scaffolded project (%s)", async (moduleType) => {
		const dir = makeTempDir()
		await runScaffold(dir, moduleType)
		expect(() => runTscNoEmit(dir)).not.toThrow()
	}, 60_000)
})
