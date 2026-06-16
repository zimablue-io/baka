import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"

const SKIP_DIRS = new Set(["node_modules", "dist", ".baka", ".git", "coverage", ".next", "out"])

export async function explicitReturnTypes(state: OrchestrationState) {
	const diagnostics: Array<{ severity: "warning"; rule: string; message: string; file?: string }> = []
	const root = state.targetDirectory
	walk(root, (file) => {
		if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file.endsWith(".test.ts")) return
		const text = readFileSync(file, "utf-8")
		// Flag exported functions and methods whose declared signature lacks an
		// explicit return type. The regex is intentionally minimal: it covers
		// `export function foo(...) {` and `public foo(...) {`.
		const re = /(^|\n)\s*(export\s+(?:async\s+)?function\s+\w+[^{]*\{|public\s+\w+\s*\([^)]*\)\s*\{)/g
		const matches = text.match(re)
		if (!matches) return
		for (const m of matches) {
			// Make sure the captured signature does not end with `): TYPE`.
			const sig = m
				.replace(/^\s+/, "")
				.replace(/\{\s*$/, "")
				.trim()
			if (!sig.includes(")")) continue
			if (sig.includes("): ")) continue
			// Don't double-flag the same signature if the function uses a
			// multi-line signature ending in `Promise<X>`.
			diagnostics.push({
				severity: "warning",
				rule: "explicit-return-types",
				message: `${file}: \`${sig.slice(0, 60)}\` has no explicit return type`,
				file,
			})
		}
	})
	return diagnostics
}

function walk(dir: string, visit: (file: string) => void): void {
	let entries: import("node:fs").Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue
			walk(join(dir, entry.name), visit)
		} else if (entry.isFile()) {
			visit(join(dir, entry.name))
		}
	}
}
