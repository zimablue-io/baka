import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"

// Files we never inspect: test fixtures, generated code, lockfiles, JSON config.
const SKIP_DIRS = new Set(["node_modules", "dist", ".baka", ".git", "coverage", ".next", "out"])
const SKIP_EXTS = new Set([".test.ts", ".test.tsx", ".json", ".lock", ".md"])

export async function noAnyTypes(state: OrchestrationState) {
	const diagnostics: Array<{ severity: "error"; rule: string; message: string; file?: string }> = []
	const root = state.targetDirectory
	walk(root, (file) => {
		if (SKIP_EXTS.has(extension(file))) return
		if (file.endsWith(".d.ts")) return
		const text = readFileSync(file, "utf-8")
		// Crude but effective: flag any `: any` and `<any>` and `as any`. False
		// positives in comments are rare; a real implementation would use a TS
		// AST (see packages/ast-tooling).
		const re = /:\s*any\b|<any>|as\s+any\b/g
		const matches = text.match(re)
		if (matches && matches.length > 0) {
			diagnostics.push({
				severity: "error",
				rule: "no-any-types",
				message: `${file}: ${matches.length} use(s) of \`any\``,
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

function extension(file: string): string {
	const i = file.lastIndexOf(".")
	return i === -1 ? "" : file.slice(i)
}
