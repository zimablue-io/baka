// ---------------------------------------------------------------------------
// Unit tests for the no-any-types module validator.
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { noAnyTypes } from "./no-any-types.js"

let tempDir: string

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "baka-no-any-types-"))
	mkdirSync(join(tempDir, "src"), { recursive: true })
})

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

function stateFixture(): OrchestrationState {
	return {
		userIntent: "test",
		targetDirectory: tempDir,
		status: "VALIDATING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
}

describe("noAnyTypes", () => {
	it("ignores .test.ts files while still flagging real any usage in source files", async () => {
		writeFileSync(join(tempDir, "src", "util.ts"), "export const x = 1;\n", "utf-8")
		writeFileSync(join(tempDir, "src", "util.test.ts"), "const y = {} as any;\n", "utf-8")
		writeFileSync(join(tempDir, "src", "bad.ts"), "const z: any = 1;\n", "utf-8")

		const diagnostics = await noAnyTypes(stateFixture())
		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].file).toBe(join(tempDir, "src", "bad.ts"))
		expect(diagnostics[0].rule).toBe("no-any-types")
	})

	it("reports zero diagnostics when only test files contain any", async () => {
		writeFileSync(join(tempDir, "src", "util.ts"), "export const x = 1;\n", "utf-8")
		writeFileSync(join(tempDir, "src", "util.test.ts"), "const y = {} as any;\n", "utf-8")

		const diagnostics = await noAnyTypes(stateFixture())
		expect(diagnostics).toHaveLength(0)
	})
})
