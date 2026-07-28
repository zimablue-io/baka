import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { OrchestrationState } from "baka-sdk"
import { afterEach, describe, expect, it } from "vitest"
import { installConfigAction } from "../install-config/action.js"
import { lintAction, resolveBiomeBin } from "./action.js"

const cleanup: string[] = []
const originalCwd = process.cwd()

afterEach(() => {
	process.chdir(originalCwd)
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ts-style-lint-"))
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

const CONFORMING_TS = "export function add(a: number, b: number): number {\n\treturn a + b\n}\n"
const VIOLATING_TS = "export const x: any = 1\ndebugger\n"

describe("ts-style lint action", () => {
	it("fails honestly when the project has no biome configuration", async () => {
		const dir = makeTempDir()
		process.chdir(dir)
		const result = await lintAction.execute({}, makeState(dir))
		expect(result.success).toBe(false)
		expect(result.error).toContain("no biome configuration found")
		expect(result.error).toContain("install-config")
	})

	it("reports zero diagnostics for a conforming project set up by install-config", async () => {
		const dir = makeTempDir()
		const install = await installConfigAction.execute({}, makeState(dir))
		expect(install.success).toBe(true)
		mkdirSync(join(dir, "src"), { recursive: true })
		writeFileSync(join(dir, "src", "good.ts"), CONFORMING_TS)
		process.chdir(dir)
		const result = await lintAction.execute({}, makeState(dir))
		expect(result.success).toBe(true)
		expect(result.output.errors).toBe(0)
		expect(result.output.warnings).toBe(0)
		expect(result.output.diagnostics).toEqual([])
	})

	it("reports diagnostics for the violating file and none for the conforming file", async () => {
		const dir = makeTempDir()
		const install = await installConfigAction.execute({}, makeState(dir))
		expect(install.success).toBe(true)
		mkdirSync(join(dir, "src"), { recursive: true })
		writeFileSync(join(dir, "src", "good.ts"), CONFORMING_TS)
		writeFileSync(join(dir, "src", "bad.ts"), VIOLATING_TS)
		process.chdir(dir)
		const result = await lintAction.execute({}, makeState(dir))
		expect(result.success).toBe(true)
		const files = result.output.diagnostics.map((d) => d.file)
		expect(files).toContain("src/bad.ts")
		expect(files).not.toContain("src/good.ts")
		const rules = result.output.diagnostics.map((d) => d.rule)
		expect(rules).toContain("lint/suspicious/noExplicitAny")
		expect(result.output.errors + result.output.warnings).toBeGreaterThan(0)
	})
})

describe("resolveBiomeBin", () => {
	it("prefers the project's own biome install, walking up from the target", () => {
		const dir = makeTempDir()
		const nested = join(dir, "packages", "app")
		const fake = join(dir, "node_modules", "@biomejs", "biome", "bin", "biome")
		mkdirSync(dirname(fake), { recursive: true })
		mkdirSync(nested, { recursive: true })
		writeFileSync(fake, "// fake biome bin\n")
		expect(resolveBiomeBin(nested)).toBe(fake)
	})

	it("falls back to the biome bundled with ts-style", () => {
		const dir = makeTempDir()
		const resolved = resolveBiomeBin(dir)
		expect(resolved).not.toBeNull()
		expect(resolved?.startsWith(dir)).toBe(false)
		expect(resolved?.endsWith(join("@biomejs", "biome", "bin", "biome"))).toBe(true)
	})
})
