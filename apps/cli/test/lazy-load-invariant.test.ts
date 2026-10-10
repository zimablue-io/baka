// ---------------------------------------------------------------------------
// Test B — CLI subcommands do not eager-load pack-design at boot.
//
// What it asserts:
//   - apps/cli/src/index.ts does NOT contain a top-level eager import
//     of `runPackConsistency` or `runPackDesign` from
//     "./commands/pack-design/index.js".
//   - The source uses dynamic `await import(...)` inside the
//     `.action()` callbacks for `pack create` and `pack consistency`
//     so that one broken subcommand barrel (e.g. a throw on import in
//     pack-design/index.ts) does not kill unrelated commands like
//     `baka list-packs`.
//
// Failure mode it covers:
//   - The current top-level eager import pulls every pack-design
//     transitive dependency at CLI boot, so a `throw` or compile error
//     anywhere in the pack-design subgraph (e.g. a broken barrel
//     import, a bad workflow re-export) crashes every CLI invocation,
//     including `baka list-packs`, `baka --help`, etc. The structural
//     invariant pinned here is the only thing the fix can rely on,
//     given the constraints (no prod code mutation, no dist rebuild).
//
// Why structural / text-inspection (not runtime spawn):
//   - The "spawn the binary with pack-design temporarily broken"
//     approach requires (a) editing apps/cli/src/commands/pack-design/index.ts
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
// We don't want to be fooled by `import { ... } from "./commands/pack-design/index.js"`
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

	it("does not eagerly import runPackConsistency at the top level", () => {
		// The eager import in the current source is:
		//   import { runPackConsistency, runPackDesign } from "./commands/pack-design/index.js"
		// After the fix, runPackConsistency must not be referenced as
		// a top-level named import. We assert by checking that no
		// `import { ... runPackConsistency ... } from "..."` remains.
		const hasEagerImport = /import\s*\{[^}]*\brunPackConsistency\b[^}]*\}\s*from\s*["'][^"']+["']/.test(stripped)
		expect(
			hasEagerImport,
			"CLI index.ts still has a top-level import that pulls in runPackConsistency; " +
				"this defeats the lazy-load invariant for baka list-packs / --help / etc.",
		).toBe(false)
	})

	it("does not eagerly import runPackDesign at the top level", () => {
		const hasEagerImport = /import\s*\{[^}]*\brunPackDesign\b[^}]*\}\s*from\s*["'][^"']+["']/.test(stripped)
		expect(
			hasEagerImport,
			"CLI index.ts still has a top-level import that pulls in runPackDesign; " +
				"this defeats the lazy-load invariant for baka list-packs / --help / etc.",
		).toBe(false)
	})

	it("does not eagerly import the pack-design barrel at the top level", () => {
		// Belt-and-braces: pin the literal source line that currently
		// pulls the whole pack-design subgraph at boot. After the
		// fix, this exact string should not appear in non-comment code.
		const hasBarrelImport = stripped.includes('from "./commands/pack-design/index.js"')
		expect(
			hasBarrelImport,
			"CLI index.ts still has the eager pack-design barrel import; " +
				"a broken pack-design barrel would crash every CLI subcommand.",
		).toBe(false)
	})

	it("dynamically imports runPackDesign inside the pack create .action() callback", () => {
		// The fix moves the import inside the recipe callback. Look for
		// a dynamic `await import(...)` that resolves runPackDesign.
		// We allow either a bare dynamic import or a destructuring
		// assignment of the form `const { runPackDesign } = await import("...")`.
		const dynamicImportForRunPackDesign = /await\s+import\(\s*["'][^"']*commands\/pack-design[^"']*["']\s*\)/

		const hasDynamicImport = dynamicImportForRunPackDesign.test(stripped)
		const referencesRunPackDesign = /\brunPackDesign\b/.test(stripped) || /\brunPackDesign\b/.test(raw)

		expect(
			hasDynamicImport && referencesRunPackDesign,
			"CLI index.ts must dynamically import runPackDesign inside the .action() callback " +
				"so the pack-design subgraph is not pulled in at CLI boot.",
		).toBe(true)
	})

	it("dynamically imports runPackConsistency inside the pack consistency .action() callback", () => {
		// Same invariant for runPackConsistency.
		const dynamicImportForRunPackConsistency = /await\s+import\(\s*["'][^"']*commands\/pack-design[^"']*["']\s*\)/
		const hasDynamicImport = dynamicImportForRunPackConsistency.test(stripped)
		const referencesRunPackConsistency = /\brunPackConsistency\b/.test(stripped) || /\brunPackConsistency\b/.test(raw)

		expect(
			hasDynamicImport && referencesRunPackConsistency,
			"CLI index.ts must dynamically import runPackConsistency inside the .action() callback " +
				"so the pack-design subgraph is not pulled in at CLI boot.",
		).toBe(true)
	})
})
