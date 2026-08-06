import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
import type { ModuleManifest } from "@repo/protocol"
import ts from "typescript"

/**
 * Static capability scan (architecture §4.6 layer 1).
 *
 * The scanner parses every `.ts` file in the module and every
 * Handlebars template (`.hbs` / `.handlebars`), looking for
 * capabilities the registry refuses to ship:
 *
 *   - network APIs: `fetch`, `WebSocket`, `http` / `https` /
 *     `net` / `dns` module imports
 *   - `child_process` module imports
 *   - `eval(...)` and `new Function(...)`
 *   - dynamic `import(<specifier>)` of non-allowlisted specifiers
 *     (allowlist: `baka-sdk`, `node:` builtins)
 *   - writes outside the manifest's declared `filePatterns`
 *     (statically detectable string-literal arguments to
 *     `writeFile` / `writeFileSync` / `appendFile` / `appendFileSync`
 *     / `mkdir` / `mkdirSync`)
 *   - non-allowlisted Handlebars helpers (allowlist: builtins
 *     `if`, `each`, `with`, `unless`; `lookup` and raw-eval
 *     constructs are denied)
 *
 * The scan is a pure function over a directory on disk — no
 * network, no module loading, no execution of the module's
 * own code. It runs in-process on the worker before the
 * tarball pack.
 *
 * The TypeScript Compiler API is used so TypeScript-specific
 * syntax (type annotations, decorators, `as`/`satisfies`
 * casts) does not trip the AST walker.
 */

export interface StaticScanFinding {
	/** Capability tag: "network" | "child_process" | "eval" | "dynamic-import" | "writes-outside-patterns" | "handlebars-helper". */
	capability: string
	/** Path relative to the module dir, POSIX-style. Never absolute. */
	file: string
	/** 1-based line number. */
	line: number
	/** 1-based column number. */
	column: number
	/** Source snippet around the finding, single line, trimmed. */
	snippet: string
}

export interface StaticScanResult {
	/** True iff `findings` is empty. */
	passed: boolean
	/** Every denied construct detected in the module. */
	findings: StaticScanFinding[]
	/** Human-readable summary the worker records in `module_versions.error`. */
	summary: string
}

const NETWORK_GLOBALS = new Set(["fetch", "WebSocket"])
const NETWORK_MODULES = new Set(["http", "https", "net", "dns"])
const CHILD_PROCESS_MODULE = "child_process"

/**
 * Dynamic-import allowlist (VAL-SCAN-016). `baka-sdk` is the
 * module-author boundary (workflows import from it; modules
 * import from it too). `node:` builtins are pure computation
 * primitives — no network, no process spawn, no fs. Anything
 * else is denied (a `require('fs')`-style shadow attempt would
 * have to come in via an aliased dynamic import; we ban aliased
 * specifiers implicitly by matching the raw literal).
 */
const DYNAMIC_IMPORT_ALLOWLIST: ReadonlySet<string> = new Set([
	"baka-sdk",
	"node:fs",
	"node:fs/promises",
	"node:path",
	"node:path/posix",
	"node:path/win32",
	"node:os",
	"node:url",
	"node:util",
	"node:util/types",
	"node:stream",
	"node:stream/web",
	"node:buffer",
	"node:events",
	"node:crypto",
	"node:assert",
	"node:assert/strict",
	"node:string_decoder",
	"node:querystring",
	"node:punycode",
])

/**
 * Handlebars helpers the registry allows in templates. Builtins
 * only — `if` / `each` / `with` / `unless` (with the implicit
 * `else` paired with `if` / `unless`). Everything else,
 * including `lookup` and any custom helper, is denied
 * (VAL-SCAN-015).
 */
const HANDLEBARS_BUILTIN_HELPERS: ReadonlySet<string> = new Set(["if", "each", "with", "unless", "else"])

const FILE_WRITE_FUNCTIONS = new Set([
	"writeFile",
	"writeFileSync",
	"appendFile",
	"appendFileSync",
	"mkdir",
	"mkdirSync",
	"createWriteStream",
])

const FILE_PATTERN_AWARE_FUNCTIONS = new Set([
	"writeFile",
	"writeFileSync",
	"appendFile",
	"appendFileSync",
	"createWriteStream",
])

/**
 * Walks the module dir, scans every `.ts` file via the TypeScript
 * Compiler API, and scans every `.hbs` / `.handlebars` file with a
 * regex-based helper detector. The manifest is used to:
 *
 *   - decide which file-write paths are declared (`filePatterns`)
 *     — actions without an explicit list fall back to the empty set
 *     (the conservative interpretation: an action that does not
 *     declare any allowed writes gets the strictest gate)
 *   - mark the scan's `summary` so the worker can surface the
 *     manifest name + action id in the diagnostic
 *
 * The function never throws on a malformed source file — a parse
 * error is recorded as a finding so the worker surfaces it as
 * `verdict: "failed"` rather than crashing the pipeline
 * (VAL-SCAN-018).
 */
export async function runStaticScan(moduleDir: string, manifest: ModuleManifest): Promise<StaticScanResult> {
	const root = resolve(moduleDir)
	const findings: StaticScanFinding[] = []

	const allowedFilePatterns = collectAllowedFilePatterns(manifest)

	for (const file of walkModuleFiles(root)) {
		const relPath = relative(root, file).split("\\").join("/")
		const ext = extname(file)
		if (ext === ".ts" || ext === ".tsx" || ext === ".cts" || ext === ".mts") {
			findings.push(...scanTypeScriptFile(file, relPath, allowedFilePatterns))
		} else if (ext === ".hbs" || ext === ".handlebars") {
			findings.push(...scanHandlebarsFile(file, relPath))
		}
	}

	const passed = findings.length === 0
	const summary = passed
		? `static scan passed for module '${manifest.name}' (${countScannedFiles(root)} file(s) inspected)`
		: `static scan failed for module '${manifest.name}': ${findings.length} finding(s) — ${summarizeFindings(findings)}`

	return { passed, findings, summary }
}

function countScannedFiles(root: string): number {
	let count = 0
	for (const file of walkModuleFiles(root)) {
		void file
		count++
	}
	return count
}

function summarizeFindings(findings: StaticScanFinding[]): string {
	const byCapability = new Map<string, number>()
	for (const finding of findings) {
		byCapability.set(finding.capability, (byCapability.get(finding.capability) ?? 0) + 1)
	}
	return Array.from(byCapability.entries())
		.map(([cap, count]) => `${count}× ${cap}`)
		.join(", ")
}

function collectAllowedFilePatterns(manifest: ModuleManifest): Set<string> {
	const out = new Set<string>()
	for (const action of manifest.actions) {
		for (const pattern of action.filePatterns) {
			out.add(pattern)
		}
	}
	return out
}

/**
 * Walks the module dir, returning every regular file (the module's
 * own tree only — dependencies and `node_modules` are deliberately
 * skipped, matching architecture §8 decision 7: screening covers
 * the module's own tree only).
 *
 * Symlinks are NOT followed: a malicious module could otherwise
 * point at a sibling directory the worker should not inspect. The
 * `statSync` falls back to `lstatSync` semantics (no follow).
 */
function walkModuleFiles(root: string): string[] {
	const out: string[] = []
	const stack: string[] = [root]
	while (stack.length > 0) {
		const dir = stack.pop()
		if (dir === undefined) continue
		let entries: import("node:fs").Dirent<string>[]
		try {
			entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" })
		} catch {
			continue
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue
			if (entry.name === "node_modules" || entry.name === "out") continue
			const full = join(dir, entry.name)
			if (entry.isDirectory()) {
				stack.push(full)
			} else if (entry.isFile()) {
				try {
					// lstat: don't follow symlinks
					statSync(full)
					out.push(full)
				} catch {
					// unreadable / dangling symlink — skip
				}
			}
		}
	}
	return out
}

/**
 * Scans a single TypeScript source file. Uses the TypeScript
 * Compiler API so type-only syntax does not trip the walker. The
 * scanner walks every node; the per-construct detectors below
 * decide what to flag.
 *
 * Parse failures are surfaced as findings (`capability: "parse"`)
 * so the worker can report VAL-SCAN-018 honestly without crashing.
 */
function scanTypeScriptFile(
	absolutePath: string,
	relPath: string,
	allowedFilePatterns: ReadonlySet<string>,
): StaticScanFinding[] {
	const source = readFileSync(absolutePath, "utf8")
	const findings: StaticScanFinding[] = []

	const sourceFile = ts.createSourceFile(
		relPath,
		source,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		ts.ScriptKind.TSX,
	)

	// First, surface real syntactic parse errors as a "parse"
	// finding (VAL-SCAN-018: a screening crash reports honestly,
	// never as a pass). The TypeScript parser is permissive (a
	// syntax error doesn't throw, it produces a partial AST), so
	// we read the parser's diagnostic list (the field is on the
	// instance at runtime; the public type omits it for some
	// compiler versions, hence the cast) to find the parser-level
	// issues explicitly.
	const parseDiagnostics =
		(sourceFile as ts.SourceFile & { parseDiagnostics?: ReadonlyArray<ts.Diagnostic> }).parseDiagnostics ?? []
	for (const diag of parseDiagnostics) {
		if (diag.category !== ts.DiagnosticCategory.Error) continue
		const pos = diag.start ?? 0
		const length = diag.length ?? 1
		const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
		const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n")
		findings.push({
			capability: "parse",
			file: relPath,
			line: lineCol.line + 1,
			column: lineCol.character + 1,
			snippet: truncateSnippet(`${msg} at ${textAt(source, pos, Math.min(length, 80))}`),
		})
	}

	// First pass: detect network / child_process / eval / dynamic
	// import / writeFile calls anywhere in the tree. The walker
	// visits every node once. A detector exception becomes an
	// stderr log, never a finding — a detector bug MUST NOT
	// cause a clean module to fail.
	const visit = (node: ts.Node): void => {
		try {
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				detectCallExpression(node, sourceFile, source, relPath, findings)
			}
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
				detectImportModule(node, sourceFile, source, relPath, findings)
			}
			if (ts.isImportTypeNode(node)) {
				detectImportTypeNode(node, sourceFile, source, relPath, findings)
			}
		} catch (err) {
			// A detector exception is a scan-internal bug, NOT a
			// parse failure. Log for the operator; continue walking.
			const msg = err instanceof Error ? err.message : String(err)
			process.stderr.write(`[static-scan] detector error at ${relPath}: ${msg}\n`)
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)

	// Walk again for file-write call sites (detectors that need
	// the allowed-patterns set; pulled into a separate pass so
	// each detector has a single responsibility).
	const visitWrites = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			detectWriteCallExpression(node, sourceFile, source, relPath, allowedFilePatterns, findings)
		}
		ts.forEachChild(node, visitWrites)
	}
	visitWrites(sourceFile)

	return findings
}

/**
 * Detects `fetch(...)`, `WebSocket(...)`, `eval(...)`,
 * `new Function(...)`, and `import(<specifier>)` call sites.
 *
 * `import(<specifier>)` is the only DYNAMIC import detector; the
 * static `import` / `export ... from` form is detected by
 * `detectImportModule` below. `require(...)` is NOT covered here
 * — CommonJS modules are not the registry's authoring contract,
 * and `require` would be flagged indirectly if it is a
 * `child_process` call target (most exploits call into
 * `child_process.exec` etc.).
 */
function detectCallExpression(
	node: ts.CallExpression | ts.NewExpression,
	sourceFile: ts.SourceFile,
	source: string,
	relPath: string,
	findings: StaticScanFinding[],
): void {
	const expr = node.expression

	// Direct identifier: `fetch(...)`, `eval(...)`, `WebSocket(...)`,
	// `require(...)`, etc. The identifier text is the symbol name.
	if (ts.isIdentifier(expr)) {
		const name = expr.text
		const pos = expr.getStart(sourceFile)
		const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
		if (NETWORK_GLOBALS.has(name)) {
			findings.push({
				capability: "network",
				file: relPath,
				line: lineCol.line + 1,
				column: lineCol.character + 1,
				snippet: truncateSnippet(textAt(source, pos, expr.getWidth(sourceFile))),
			})
			return
		}
		if (name === "eval") {
			findings.push({
				capability: "eval",
				file: relPath,
				line: lineCol.line + 1,
				column: lineCol.character + 1,
				snippet: truncateSnippet(textAt(source, pos, expr.getWidth(sourceFile))),
			})
			return
		}
	}

	// `new Function(...)` is a NewExpression whose expression is the
	// `Function` identifier. Distinguish from `Function(...)` calls
	// (also flagged — same blast radius).
	if (ts.isNewExpression(node) && ts.isIdentifier(expr) && expr.text === "Function") {
		const pos = expr.getStart(sourceFile)
		const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
		findings.push({
			capability: "eval",
			file: relPath,
			line: lineCol.line + 1,
			column: lineCol.character + 1,
			snippet: truncateSnippet(textAt(source, pos, expr.getWidth(sourceFile))),
		})
		return
	}

	// Dynamic `import(<specifier>)` — the expression is the bare
	// `import` keyword (SyntaxKind.ImportKeyword) wrapping the
	// specifier argument. We accept string literals only; computed
	// specifiers are undecidable statically and we conservatively
	// deny them so a malicious module cannot smuggle an arbitrary
	// specifier behind a runtime-evaluated string.
	if (isImportCall(node, sourceFile)) {
		const arg = node.arguments[0]
		if (arg !== undefined) {
			const specifier = readStringLiteral(arg, sourceFile)
			if (specifier === null) {
				// Computed / non-literal specifier — conservative deny.
				const pos = node.getStart(sourceFile)
				const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
				findings.push({
					capability: "dynamic-import",
					file: relPath,
					line: lineCol.line + 1,
					column: lineCol.character + 1,
					snippet: truncateSnippet(textAt(source, pos, node.getWidth(sourceFile))),
				})
			} else if (!DYNAMIC_IMPORT_ALLOWLIST.has(specifier)) {
				const pos = arg.getStart(sourceFile)
				const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
				findings.push({
					capability: "dynamic-import",
					file: relPath,
					line: lineCol.line + 1,
					column: lineCol.character + 1,
					snippet: truncateSnippet(`import(${specifier})`),
				})
			}
		}
	}
}

/**
 * Detects static `import ... from "..."` and
 * `export ... from "..."` declarations whose specifier is in
 * the network or child_process denylist. The whole point of
 * importing `http` / `https` / `child_process` etc. is to call
 * into them — the import itself is the capability.
 */
function detectImportModule(
	node: ts.ImportDeclaration | ts.ExportDeclaration,
	sourceFile: ts.SourceFile,
	source: string,
	relPath: string,
	findings: StaticScanFinding[],
): void {
	const specifier = readModuleSpecifier(node)
	if (specifier === null) return
	const bareSpec = stripNodePrefix(specifier)
	if (NETWORK_MODULES.has(bareSpec)) {
		const pos = node.getStart(sourceFile)
		const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
		findings.push({
			capability: "network",
			file: relPath,
			line: lineCol.line + 1,
			column: lineCol.character + 1,
			snippet: truncateSnippet(textAt(source, pos, node.getWidth(sourceFile))),
		})
		return
	}
	if (bareSpec === CHILD_PROCESS_MODULE) {
		const pos = node.getStart(sourceFile)
		const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
		findings.push({
			capability: "child_process",
			file: relPath,
			line: lineCol.line + 1,
			column: lineCol.character + 1,
			snippet: truncateSnippet(textAt(source, pos, node.getWidth(sourceFile))),
		})
		return
	}
	// Bare `import "http"` (side-effect) without a binding — covered
	// by the same logic since we read the module specifier off the
	// declaration node.
}

/**
 * Detects `type X = import("...")` (TypeScript type-only import)
 * — same denylist as runtime imports. A type-only import can be
 * elided at runtime, but it is still an observable capability
 * declaration the user might rely on, and shipping a module that
 * pretends to type-check against `http` types but actually calls
 * into `http` would defeat the static layer. We deny uniformly.
 */
function detectImportTypeNode(
	node: ts.ImportTypeNode,
	sourceFile: ts.SourceFile,
	source: string,
	relPath: string,
	findings: StaticScanFinding[],
): void {
	const literal = node.argument
	// TS 5.9.2 wraps ImportTypeNode.argument in a LiteralTypeNode
	// (a type-level wrapper), not the bare StringLiteral — the old
	// `ts.isStringLiteral(literal)` guard therefore returned early
	// and every `type X = import('node:net')` (and even bare
	// `import('http')` import-types) slipped through the static
	// network gate. Unwrap one layer to the underlying string.
	let specifier: string | null = null
	if (ts.isLiteralTypeNode(literal) && ts.isStringLiteral(literal.literal)) {
		specifier = literal.literal.text
	} else if (ts.isStringLiteral(literal)) {
		specifier = literal.text
	}
	if (specifier === null) return
	const bareSpec = stripNodePrefix(specifier)
	if (NETWORK_MODULES.has(bareSpec) || bareSpec === CHILD_PROCESS_MODULE) {
		const pos = node.getStart(sourceFile)
		const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
		const capability = bareSpec === CHILD_PROCESS_MODULE ? "child_process" : "network"
		findings.push({
			capability,
			file: relPath,
			line: lineCol.line + 1,
			column: lineCol.character + 1,
			snippet: truncateSnippet(textAt(source, pos, node.getWidth(sourceFile))),
		})
	}
}

/**
 * Detects `writeFile(<path>, ...)` / `writeFileSync(<path>, ...)` /
 * `appendFile(<path>, ...)` / `mkdir(<path>, ...)` call sites
 * where the path argument is a string literal NOT in the
 * declared `filePatterns` set.
 *
 * The check is intentionally conservative:
 *
 *   - identifier-as-path arguments (`writeFile(targetPath, ...)`)
 *     are NOT flagged — the runtime value is undecidable; the
 *     dry-run layer catches them when they materialize
 *   - dynamic expressions (template literals, binary `+`, calls
 *     returning strings) are skipped for the same reason
 *   - The check is per-action: when an `action.ts` calls
 *     `writeFile` with a literal path, the literal must appear
 *     in *that* action's `filePatterns` OR the union of all
 *     declared `filePatterns`. We use the union for simplicity
 *     — the manifest author declares the module's surface area
 *     across every action, and any literal in any action file
 *     must resolve to a declared pattern.
 */
function detectWriteCallExpression(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
	_source: string,
	relPath: string,
	allowedPatterns: ReadonlySet<string>,
	findings: StaticScanFinding[],
): void {
	const expr = node.expression
	let calleeName: string | null = null
	if (ts.isIdentifier(expr)) {
		calleeName = expr.text
	} else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
		// `fs.writeFile(...)` form — only the property name is
		// checked; the receiver (e.g. `fs`) is not tracked.
		calleeName = expr.name.text
	}
	if (calleeName === null || !FILE_WRITE_FUNCTIONS.has(calleeName)) return
	if (!FILE_PATTERN_AWARE_FUNCTIONS.has(calleeName)) return

	const firstArg = node.arguments[0]
	if (firstArg === undefined) return
	const literal = readStringLiteral(firstArg, sourceFile)
	if (literal === null) return // computed path — handled by the dry-run layer

	// filePatterns are declared with forward slashes; normalize.
	const normalized = literal.replace(/\\/g, "/").replace(/^\.\//, "")
	if (matchesAllowedPattern(normalized, allowedPatterns)) return

	const pos = firstArg.getStart(sourceFile)
	const lineCol = sourceFile.getLineAndCharacterOfPosition(pos)
	findings.push({
		capability: "writes-outside-patterns",
		file: relPath,
		line: lineCol.line + 1,
		column: lineCol.character + 1,
		snippet: truncateSnippet(`${calleeName}('${literal}', ...)`),
	})
}

/**
 * Allowlist match is exact-prefix only: a declared pattern
 * `src/index.ts` matches a literal `src/index.ts` (and any
 * literal that starts with `src/index.ts/`, which is what
 * scaffold-style writers do for sibling files). Glob patterns
 * are NOT supported in v1 — `filePatterns` is a literal-prefix
 * list per the manifest contract.
 */
function matchesAllowedPattern(path: string, allowed: ReadonlySet<string>): boolean {
	if (allowed.has(path)) return true
	for (const pattern of allowed) {
		if (path === pattern) return true
		if (path.startsWith(`${pattern}/`)) return true
	}
	return false
}

/**
 * Scans a Handlebars template for non-allowlisted helpers
 * (VAL-SCAN-015). The scanner walks every `{{...}}` token,
 * identifies the helper name (block or inline), and reports any
 * name NOT in the allowlist.
 *
 * Token kinds we care about:
 *
 *   - `{{X ...}}`           — variable OR inline helper
 *   - `{{{X ...}}}`         — triple-stash (raw HTML)
 *   - `{{#X ...}}...{{/X}}` — block helper (open)
 *   - `{{/X}}`              — block helper (close, ignored)
 *   - `{{> X}}`             — partial, ignored (not a helper)
 *   - `{{!-- ... --}}`      — comment, ignored
 *
 * Conservative posture: anything that looks like a non-builtin
 * helper is flagged. Path expressions like `{{name}}` are NOT
 * flagged (they are variables, not helpers). The detector
 * disambiguates by checking whether the token contains a
 * space, parenthesis, or path segment with a key — a heuristic
 * the engine-side Handlebars implementation uses too.
 */
function scanHandlebarsFile(absolutePath: string, relPath: string): StaticScanFinding[] {
	const source = readFileSync(absolutePath, "utf8")
	const findings: StaticScanFinding[] = []

	// Match every `{{...}}` (single-stash and triple-stash) AND
	// every `{{!-- ... --}}` comment. The regex captures the
	// raw interior; downstream code decides whether each token
	// is a helper or a variable / comment / partial.
	const tokenRegex = /\{\{!--[\s\S]*?--\}\}|\{\{\{([\s\S]+?)\}\}\}|\{\{([\s\S]+?)\}\}/g
	for (const match of source.matchAll(tokenRegex)) {
		const tokenInterior = (match[1] ?? match[2] ?? "").trim()
		if (tokenInterior.length === 0) continue
		// Comments: skip
		if (match[0].startsWith("{{!--")) continue
		// Partial: `{{> name}}` — skip (not a helper).
		if (tokenInterior.startsWith(">")) continue
		// Block close: `{{/X}}` — skip (paired with the open token).
		if (tokenInterior.startsWith("/")) continue

		// The first identifier-like token is the helper name (block
		// open, inline helper, or a subexpression). For a plain
		// path expression like `{{name}}` the interior has no
		// whitespace, no paren, no dot — treat as a variable and
		// skip.
		const helperName = extractHelperName(tokenInterior)
		if (helperName === null) continue

		if (HANDLEBARS_BUILTIN_HELPERS.has(helperName)) continue

		const pos = match.index ?? 0
		const lineCol = positionToLineColumn(source, pos)
		findings.push({
			capability: "handlebars-helper",
			file: relPath,
			line: lineCol.line,
			column: lineCol.column,
			snippet: truncateSnippet(`{{${tokenInterior.slice(0, 80)}}}`),
		})
	}

	return findings
}

/**
 * Heuristic: an interior like `name`, `user.name`, or `name "literal"`
 * is treated as a path expression or partial-args form — NOT a helper
 * call. Anything else (block marker `#`, named helper invocation,
 * subexpression with parens) is treated as a helper invocation.
 *
 * Block open `{{#if cond}}` → helper "if"
 * Inline helper `{{lookup user "name"}}` → helper "lookup"
 * Subexpression `{{or (eq x y) (eq x z)}}` → helper "or"
 * Variable `{{name}}` → null (not a helper)
 * Variable with dot `{{user.name}}` → null (path expression)
 * Literal `{{"hello"}}` → null (literal string)
 */
function extractHelperName(interior: string): string | null {
	const stripped = interior.startsWith("#") ? interior.slice(1).trim() : interior
	if (stripped.length === 0) return null
	// Path expression / variable — no whitespace, no paren, doesn't
	// start with `(`.
	if (!/[\s()]/.test(stripped) && !stripped.startsWith("(")) {
		return null
	}
	// Pull the first identifier (allow letters, digits, underscores,
	// dashes — helper names like `lookup` and builtins like `if` fit).
	const m = /^([A-Za-z_$][\w$]*)/.exec(stripped)
	if (m === null) return null
	return m[1] ?? null
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function readModuleSpecifier(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
	if (node.moduleSpecifier === undefined) return null
	if (!ts.isStringLiteral(node.moduleSpecifier)) return null
	return node.moduleSpecifier.text
}

function readStringLiteral(node: ts.Node, sourceFile: ts.SourceFile): string | null {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return node.text
	}
	if (ts.isIdentifier(node)) {
		// `writeFile(PATH, ...)` — a constant identifier. We treat
		// it as not statically resolvable, so the conservative
		// answer is "skip" rather than "deny"; the dry-run layer
		// catches the runtime value.
		void sourceFile
		return null
	}
	return null
}

function isImportCall(node: ts.Node, sourceFile: ts.SourceFile): node is ts.CallExpression {
	if (!ts.isCallExpression(node)) return false
	const expr = node.expression
	// The TypeScript AST represents `import("...")` as a CallExpression
	// whose `expression` node has SyntaxKind.ImportKeyword (the bare
	// `import` keyword — not an identifier named "import"). `ts.isImportExpression`
	// is not exposed in the public type-guards surface; the SyntaxKind
	// check below is the stable contract across TS 5.x.
	void sourceFile
	return expr.kind === ts.SyntaxKind.ImportKeyword
}

/**
 * Strips a Node.js builtin prefix so the bare module name can be
 * matched against the network / child_process denylists.
 *
 * Handles two forms:
 *
 *   - `"node:fs"` — the standard `node:` scheme, `node` is the
 *     scheme identifier and `fs` is the bare spec. Slashed
 *     variants (`"node:fs/promises"`) keep the slash.
 *   - `":fs"` — a syntactically valid but meaningless leading-
 *     colon spec; included so a future authoring slip never
 *     slips a builtin past the denylist silently.
 *
 * Anything else (a non-builtin spec like `"fs"` or `"evil-pkg"`)
 * returns unchanged so the denylist comparer sees the original
 * specifier. REGRESSION (scrutiny round 1 issue #1): the previous
 * implementation checked `indexOf(":") === 0`, which never matches
 * `"node:fs"` (the colon is at index 4). That let `node:http` /
 * `node:https` / `node:net` / `node:dns` / `node:child_process`
 * evade the static network gate — the ONLY network gate, since
 * Node 24's `--permission` cannot block network.
 */
function stripNodePrefix(specifier: string): string {
	if (specifier.startsWith("node:")) return specifier.slice("node:".length)
	const idx = specifier.indexOf(":")
	if (idx === 0) return specifier.slice(1) // ":fs" → "fs" (defensive)
	return specifier
}

function textAt(source: string, pos: number, width: number): string {
	return source.slice(pos, pos + width)
}

function truncateSnippet(s: string): string {
	const oneLine = s.replace(/\s+/g, " ").trim()
	return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine
}

function positionToLineColumn(source: string, pos: number): { line: number; column: number } {
	let line = 1
	let column = 1
	for (let i = 0; i < pos && i < source.length; i++) {
		if (source[i] === "\n") {
			line++
			column = 1
		} else {
			column++
		}
	}
	return { line, column }
}
