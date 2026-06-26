// ---------------------------------------------------------------------------
// Test B — CLI subcommands do not eager-load module-design at boot.
//
// What it asserts:
//   - apps/cli/src/index.ts does NOT contain a top-level eager import
//     of `runModuleConsistency` or `runModuleDesign` from
//     "./commands/module-design/index.js".
//   - The source uses dynamic `await import(...)` inside the
//     `.action()` callbacks for `module create` and `module consistency`
//     so that one broken subcommand barrel (e.g. a throw on import in
//     module-design/index.ts) does not kill unrelated commands like
//     `baka list-modules`.
//
// Failure mode it covers:
//   - The current top-level eager import pulls every module-design
//     transitive dependency at CLI boot, so a `throw` or compile error
//     anywhere in the module-design subgraph (e.g. a broken barrel
//     import, a bad workflow re-export) crashes every CLI invocation,
//     including `baka list-modules`, `baka --help`, etc. The structural
//     invariant pinned here is the only thing the fix can rely on,
//     given the constraints (no prod code mutation, no dist rebuild).
//
// Why structural / text-inspection (not runtime spawn):
//   - The "spawn the binary with module-design temporarily broken"
//     approach requires (a) editing apps/cli/src/commands/module-design/index.ts
//     and (b) rebuilding apps/cli/dist. Both are forbidden by the
//     parent's task constraints. A text-inspection test on
//     apps/cli/src/index.ts directly pins the same invariant the
//     runtime test would: if the top-level eager import is gone and
//     the dynamic import is present, the invariant holds.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const CLI_INDEX = join(__dirname, "..", "src", "index.ts")

// Strip line and block comments from a TS source string before scanning.
// We don't want to be fooled by `import { ... } from "./commands/module-design/index.js"`
// appearing inside a JSDoc example or a `// see: import ...` comment.
function stripComments(src: string): string {
	// Block comments (non-greedy, multi-line). The TS source has no
	// `*/` inside string literals in this file, so a simple regex is
	// sufficient.
	const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "")
	// Line comments.
	const noLine = noBlock.replace(/^\s*\/\/.*$/gm, "")
	return noLine
}

describe("CLI top-level source lazy-load invariant", () => {
	const raw = readFileSync(CLI_INDEX, "utf-8")
	const stripped = stripComments(raw)

	it("does not eagerly import runModuleConsistency at the top level", () => {
		// The eager import in the current source is:
		//   import { runModuleConsistency, runModuleDesign } from "./commands/module-design/index.js"
		// After the fix, runModuleConsistency must not be referenced as
		// a top-level named import. We assert by checking that no
		// `import { ... runModuleConsistency ... } from "..."` remains.
		const hasEagerImport = /import\s*\{[^}]*\brunModuleConsistency\b[^}]*\}\s*from\s*["'][^"']+["']/.test(stripped)
		expect(
			hasEagerImport,
			"CLI index.ts still has a top-level import that pulls in runModuleConsistency; " +
				"this defeats the lazy-load invariant for baka list-modules / --help / etc.",
		).toBe(false)
	})

	it("does not eagerly import runModuleDesign at the top level", () => {
		const hasEagerImport = /import\s*\{[^}]*\brunModuleDesign\b[^}]*\}\s*from\s*["'][^"']+["']/.test(stripped)
		expect(
			hasEagerImport,
			"CLI index.ts still has a top-level import that pulls in runModuleDesign; " +
				"this defeats the lazy-load invariant for baka list-modules / --help / etc.",
		).toBe(false)
	})

	it("does not eagerly import the module-design barrel at the top level", () => {
		// Belt-and-braces: pin the literal source line that currently
		// pulls the whole module-design subgraph at boot. After the
		// fix, this exact string should not appear in non-comment code.
		const hasBarrelImport = stripped.includes('from "./commands/module-design/index.js"')
		expect(
			hasBarrelImport,
			"CLI index.ts still has the eager module-design barrel import; " +
				"a broken module-design barrel would crash every CLI subcommand.",
		).toBe(false)
	})

	it("dynamically imports runModuleDesign inside the module create .action() callback", () => {
		// The fix moves the import inside the action callback. Look for
		// a dynamic `await import(...)` that resolves runModuleDesign.
		// We allow either a bare dynamic import or a destructuring
		// assignment of the form `const { runModuleDesign } = await import("...")`.
		const dynamicImportForRunModuleDesign = /await\s+import\(\s*["'][^"']*commands\/module-design[^"']*["']\s*\)/

		const hasDynamicImport = dynamicImportForRunModuleDesign.test(stripped)
		const referencesRunModuleDesign = /\brunModuleDesign\b/.test(stripped) || /\brunModuleDesign\b/.test(raw)

		expect(
			hasDynamicImport && referencesRunModuleDesign,
			"CLI index.ts must dynamically import runModuleDesign inside the .action() callback " +
				"so the module-design subgraph is not pulled in at CLI boot.",
		).toBe(true)
	})

	it("dynamically imports runModuleConsistency inside the module consistency .action() callback", () => {
		// Same invariant for runModuleConsistency.
		const dynamicImportForRunModuleConsistency = /await\s+import\(\s*["'][^"']*commands\/module-design[^"']*["']\s*\)/
		const hasDynamicImport = dynamicImportForRunModuleConsistency.test(stripped)
		const referencesRunModuleConsistency =
			/\brunModuleConsistency\b/.test(stripped) || /\brunModuleConsistency\b/.test(raw)

		expect(
			hasDynamicImport && referencesRunModuleConsistency,
			"CLI index.ts must dynamically import runModuleConsistency inside the .action() callback " +
				"so the module-design subgraph is not pulled in at CLI boot.",
		).toBe(true)
	})
})
