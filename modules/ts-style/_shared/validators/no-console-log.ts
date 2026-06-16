import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"

const SKIP_DIRS = new Set(["node_modules", "dist", ".baka", ".git", "coverage", ".next", "out"])

export async function noConsoleLog(state: OrchestrationState) {
	const diagnostics: Array<{ severity: "warning"; rule: string; message: string; file?: string }> = []
	const root = state.targetDirectory
	walk(root, (file) => {
		if (file.endsWith(".d.ts") || file.endsWith(".json") || file.endsWith(".md")) return
		const text = readFileSync(file, "utf-8")
		const re = /console\.log\(/g
		const matches = text.match(re)
		if (matches && matches.length > 0) {
			diagnostics.push({
				severity: "warning",
				rule: "no-console-log",
				message: `${file}: ${matches.length} console.log call(s); prefer the structured logger`,
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
