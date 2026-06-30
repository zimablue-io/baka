import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ValidationDiagnostic } from "baka-sdk"
import { BOUNDARY_RULES } from "../../manifest"

/**
 * Diagnostic shape for a single boundary violation. Mirrors the legacy
 * `scripts/check-boundaries.mjs` stderr format (file:line, imported
 * package name) and adds a `source` field that maps the offending
 * import back to its source package, so a downstream agent can match
 * the violation to the manifest's `BOUNDARY_RULES` entry without
 * re-parsing the message.
 */
export interface BoundaryViolation {
	source: string
	forbidden: string
	file: string
	line: number
}

export interface BoundaryCheckResult {
	ok: boolean
	diagnostics: ValidationDiagnostic[]
	violations: BoundaryViolation[]
	stdout: string
	stderr: string
}

/**
 * Recursively walk `dir` and yield absolute paths of every regular
 * `.ts` file. Mirrors the legacy script's `globSync("**\/*.ts", ...)`
 * selection. Symlinks are followed (so the live source under
 * `better-chat/packages\/*` resolves correctly when the dir is a
 * symlink); broken links are skipped silently, same as the legacy
 * script's `try/catch` fallback for missing package dirs.
 */
function walkTsFiles(dir: string): string[] {
	const out: string[] = []
	if (!existsSync(dir)) return out
	const stack = [dir]
	while (stack.length > 0) {
		const cur = stack.pop() as string
		let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
		try {
			entries = readdirSync(cur, { withFileTypes: true })
		} catch {
			// broken symlink / permission error / etc. — skip silently
			continue
		}
		for (const entry of entries) {
			// Skip test files, specs, and node_modules to match the legacy
			// script's `ignore` list.
			if (entry.name === "node_modules") continue
			if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue
			const child = join(cur, entry.name)
			if (entry.isFile() && entry.name.endsWith(".ts")) {
				out.push(child)
				continue
			}
			if (entry.isDirectory()) {
				// Follow symlinks that point at directories (better-chat uses
				// none today, but future-proof against layout changes).
				try {
					if (statSync(child).isDirectory()) stack.push(child)
				} catch {
					// broken symlink — skip silently
				}
			}
		}
	}
	return out
}

/**
 * Match a single non-comment line of source code against the
 * `@repo/...` import regex used by the legacy script. Returns the
 * imported package name (e.g. `@repo/ai`) or `null`.
 */
const IMPORT_LINE_RE = /from ['"](@repo\/[^'"]+)['"]/

function findImports(content: string): Array<{ importPath: string; line: number }> {
	const matches: Array<{ importPath: string; line: number }> = []
	const lines = content.split("\n")
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const trimmed = line.trim()
		// Skip comments — same heuristic as the legacy script.
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			continue
		}
		const m = IMPORT_LINE_RE.exec(line)
		if (!m) continue
		matches.push({ importPath: m[1], line: i + 1 })
	}
	return matches
}

/**
 * Run the boundary check against the live better-chat source using the
 * `BOUNDARY_RULES` data from the manifest. This is the in-TypeScript
 * authoritative implementation.
 *
 * Why not just spawn `scripts/check-boundaries.mjs`? Two reasons:
 *   1. The legacy script depends on the `glob` package via a dynamic
 *      `await import("glob")`. In better-chat's pnpm-hoisted layout,
 *      `glob` is not directly resolvable from `cwd`, so the dynamic
 *      import fails and the script's outer `try/catch` silently skips
 *      every rule (always reports PASS).
 *   2. The legacy script's match step builds `forbiddenName` with
 *      `forbiddenDir.replace("packages/", "@repo/")`, which yields
 *      `@repo/database/src` for rule `["packages/database/src",
 *      "packages/database/src"]`. The check then compares the import
 *      `@repo/database` against that string and never matches.
 *
 * Both bugs are pre-existing in `scripts/check-boundaries.mjs` (which
 * is read-only). The captured module owns the boundary check
 * algorithm; the manifest owns the rules.
 *
 * The check is read-only by construction (only `readFileSync` /
 * `readdirSync` are used); the live better-chat tree is never
 * mutated. No scratch dir is required — there is no subprocess to
 * isolate.
 */
export async function runBoundaryCheck(betterChatRoot: string): Promise<BoundaryCheckResult> {
	const scriptPath = join(betterChatRoot, "scripts", "check-boundaries.mjs")
	if (!existsSync(scriptPath)) {
		return {
			ok: true,
			diagnostics: [
				{
					severity: "warning",
					rule: "check-boundaries",
					message: `${scriptPath} not found; skipping boundary check (likely running outside better-chat)`,
				},
			],
			violations: [],
			stdout: "",
			stderr: "",
		}
	}

	const violations: BoundaryViolation[] = []
	let scannedFiles = 0

	for (const rule of BOUNDARY_RULES) {
		const sourcePkgDir = join(betterChatRoot, rule.sourcePkg)
		if (!existsSync(sourcePkgDir)) {
			// Mirror the legacy script's "package may not exist" skip.
			continue
		}

		const files = walkTsFiles(sourcePkgDir)
		for (const absFile of files) {
			scannedFiles++
			const content = readFileSync(absFile, "utf8")
			const imports = findImports(content)
			if (imports.length === 0) continue

			// The rule's `forbiddenImport` is in `@repo/<pkg>` form
			// (e.g. `@repo/database`); legacy imports can be either the
			// bare package (`@repo/database`) or a sub-path
			// (`@repo/database/anything`).
			const forbidden = rule.forbiddenImport
			const forbiddenPrefix = `${forbidden}/`

			for (const { importPath, line } of imports) {
				if (importPath !== forbidden && !importPath.startsWith(forbiddenPrefix)) {
					continue
				}
				// Strip the sourcePkg root to produce a project-relative
				// file path matching the legacy script's output
				// (`<sourcePkg>/<file>:<line>`).
				const relFile = absFile.startsWith(`${sourcePkgDir}/`) ? absFile.slice(sourcePkgDir.length + 1) : absFile
				const sourcePkg = mapImportToSourcePkg(rule.sourcePkg)
				violations.push({
					source: sourcePkg,
					forbidden: importPath,
					file: `${rule.sourcePkg}/${relFile}`,
					line,
				})
			}
		}
	}

	const diagnostics: ValidationDiagnostic[] = violations.map((v) => ({
		severity: "error" as const,
		rule: "check-boundaries",
		message: `${v.file}:${v.line}: imports '${v.forbidden}' which is forbidden`,
		file: v.file,
		hint: `forbiddenImport=${v.forbidden}`,
	}))

	const ok = violations.length === 0
	const stdout = ok && scannedFiles > 0 ? "✅ Package boundaries OK" : ""
	const stderr = violations.map((v) => `❌ ${v.file}:${v.line}: imports '${v.forbidden}' which is forbidden`).join("\n")

	return { ok, diagnostics, violations, stdout, stderr }
}

/**
 * Map a manifest sourcePkg directory (e.g. `packages/ui/src`) to the
 * `@repo/<name>` import name its consumers use (`@repo/ui`). The
 * mapping is: take the first segment after `packages/`, drop the
 * trailing `/src` (legacy convention).
 */
function mapImportToSourcePkg(sourcePkg: string): string {
	const match = /^packages\/([^/]+)(?:\/src)?$/.exec(sourcePkg)
	return match ? `@repo/${match[1]}` : sourcePkg
}
