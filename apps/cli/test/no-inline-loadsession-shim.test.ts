// ---------------------------------------------------------------------------
// Test C — consistency.ts no longer ships the inline loadSession shim.
//
// What it asserts:
//   - apps/cli/src/commands/module-design/consistency.ts does NOT
//     declare a local `function loadSession(` shim that re-implements
//     the workflow's session I/O.
//   - It DOES import `loadSession` from the real workflow package via
//     `import { ... loadSession ... } from "@repo/module-management-workflow"`
//     so the single source of truth is shared.
//
// Failure mode it covers:
//   - Currently consistency.ts declares a `function loadSession(...)`
//     (lines 14-25) with a comment saying it exists "to avoid tsx ESM
//     static-analysis issue when Node can't verify named exports from
//     a .ts package entry". Once the workflow barrel is fixed
//     (extensions added), that workaround becomes dead code: the real
//     `loadSession` from `@repo/module-management-workflow` is
//     reachable. Leaving the shim in place means two implementations of
//     session loading drift apart over time and a reader of the code
//     can't tell which one runs.
//
// Why structural / text-inspection (not runtime):
//   - The invariant is structural: one function must not exist, one
//     import must exist. A text scan on the source file is sufficient
//     and avoids any need to mock the module-design workflow, which
//     would itself depend on the barrel resolution the parent fix is
//     making reliable.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const CONSISTENCY_SRC = join(__dirname, "..", "src", "commands", "module-design", "consistency.ts")

function stripComments(src: string): string {
	const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "")
	const noLine = noBlock.replace(/^\s*\/\/.*$/gm, "")
	return noLine
}

describe("consistency.ts loadSession shim removal", () => {
	const raw = readFileSync(CONSISTENCY_SRC, "utf-8")
	const stripped = stripComments(raw)

	it("does not declare an inline `function loadSession(` shim", () => {
		// The shim signature in the current source is exactly:
		//   function loadSession(moduleDir: string): DesignSessionState | null {
		// We pin that down so a future shim with a different signature
		// is still caught by the spirit of the test.
		const shimPattern = /\bfunction\s+loadSession\s*\(/
		const hasShim = shimPattern.test(stripped)
		expect(
			hasShim,
			"consistency.ts still declares an inline `function loadSession(...)` shim; " +
				"once the workflow barrel is fixed, the real loadSession from " +
				"@repo/module-management-workflow is reachable and the shim should be removed.",
		).toBe(false)
	})

	it("imports loadSession from the real workflow package", () => {
		// After the fix, loadSession must come from the workflow package
		// via a single, explicit named import. We match the shape:
		//   import { ..., loadSession, ... } from "@repo/module-management-workflow"
		const importPattern = /import\s*\{[^}]*\bloadSession\b[^}]*\}\s*from\s*["']@repo\/module-management-workflow["']/
		const hasImport = importPattern.test(stripped)
		expect(
			hasImport,
			'consistency.ts does not import loadSession from "@repo/module-management-workflow"; ' +
				"the real workflow loadSession should replace the inline shim.",
		).toBe(true)
	})
})
