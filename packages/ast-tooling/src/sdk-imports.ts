import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `baka-sdk` is a types-only boundary for module code: it is not installed
 * next to a module and the engine does not alias it at run time, so a
 * runtime import fails to load in any catalog without its own node_modules.
 * `import type { X } from "baka-sdk"` and `import { type X } from "baka-sdk"`
 * are erased when the file is loaded and are fine; everything else that
 * reaches for the package at run time is not.
 */
const SDK = String.raw`baka-sdk(?:\/[^"']*)?`

const FROM_CLAUSE = new RegExp(String.raw`\b(import|export)\s+(type\s+)?([^;"']*?)\s*from\s*["']${SDK}["']`, "g")
const SIDE_EFFECT = new RegExp(String.raw`\bimport\s*["']${SDK}["']`, "g")
const CALL = new RegExp(String.raw`\b(?:require|import)\s*\(\s*["']${SDK}["']\s*\)`, "g")

export interface SdkImportFinding {
	/** 1-based line of the statement. */
	line: number
	statement: string
}

function stripComments(source: string): string {
	// Replace comment text with spaces so line numbers and offsets are unchanged.
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/(^|[\s;{}])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length))
}

/** True when every named specifier in `{ ... }` is `type`-prefixed (and there is at least one). */
function allTypeSpecifiers(clause: string): boolean {
	const match = /^\{([\s\S]*)\}$/.exec(clause.trim())
	if (!match) return false
	const specifiers = (match[1] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
	return specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s))
}

/** Every statement in `source` that uses `baka-sdk` at run time. */
export function findRuntimeSdkImports(source: string): SdkImportFinding[] {
	const text = stripComments(source)
	const lineOf = (index: number): number => text.slice(0, index).split("\n").length
	const findings: SdkImportFinding[] = []
	for (const m of text.matchAll(FROM_CLAUSE)) {
		const [statement, , typeKeyword, clause] = m
		if (typeKeyword || allTypeSpecifiers(clause ?? "")) continue
		findings.push({ line: lineOf(m.index ?? 0), statement: statement.replace(/\s+/g, " ").trim() })
	}
	for (const pattern of [SIDE_EFFECT, CALL]) {
		for (const m of text.matchAll(pattern)) {
			findings.push({ line: lineOf(m.index ?? 0), statement: m[0].replace(/\s+/g, " ").trim() })
		}
	}
	return findings.sort((a, b) => a.line - b.line)
}

const SKIP_DIRS = new Set(["node_modules", ".git", "out", "test", "tests", "__tests__", "types"])

/**
 * Runtime `baka-sdk` imports across the TypeScript a module ships and the
 * engine can load: everything under the module root except `node_modules`,
 * test and type-declaration directories, `*.d.ts`, and `*.test.ts` /
 * `*.spec.ts`. Paths are relative to the module root, POSIX-separated.
 */
export function findModuleSdkImports(moduleRoot: string): Array<SdkImportFinding & { file: string }> {
	const out: Array<SdkImportFinding & { file: string }> = []
	const walk = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const relPath = rel ? `${rel}/${entry.name}` : entry.name
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), relPath)
			} else if (
				entry.isFile() &&
				/\.(?:ts|mts|cts|tsx)$/.test(entry.name) &&
				!/\.(?:d|test|spec)\.[mc]?tsx?$/.test(entry.name)
			) {
				for (const finding of findRuntimeSdkImports(readFileSync(join(dir, entry.name), "utf-8"))) {
					out.push({ file: relPath, ...finding })
				}
			}
		}
	}
	walk(moduleRoot, "")
	return out
}
