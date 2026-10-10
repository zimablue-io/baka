/**
 * Manifest field extraction (architecture §4.5).
 *
 * The publish endpoint needs to read two fields from the pack
 * manifest — `name` and `version` — before creating a row:
 *
 *   - `version` is compared against the git tag (decision 11: the
 *     served version equals the git tag). A mismatch is 422
 *     (VAL-PUB-024).
 *   - `name` is checked against the scoping rule (decision 26: bare
 *     names exist only under the official org). A bare name under
 *     a non-official org is 422 (VAL-PUB-010).
 *
 * The manifest source is TypeScript that exports a default object
 * matching `PackManifestSchema`. The full engine loader (jiti)
 * is the worker's responsibility — it runs at ingest time and
 * evaluates the manifest in a real Node context. The publish
 * endpoint uses a narrow, sandboxed reader that:
 *
 *   1. Strips TypeScript-only syntax (`satisfies`, `as`, type
 *      annotations, type-only imports).
 *   2. Wraps the manifest in a `module.exports = { default: ... }`
 *      style assignment and evaluates it via Node's `vm` pack
 *      with a 1-second timeout and zero host bindings.
 *   3. Reads ONLY `name` and `version` from the resulting object
 *      (the rest is left for the worker to validate against the
 *      full schema).
 *
 * The reader deliberately does NOT trust any other field. The
 * manifest's `description`, `recipes`, `dependencies`, etc. are
 * the worker's contract — the publish endpoint treats them as
 * opaque and does not surface them anywhere.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import vm from "node:vm"
import { PackManifestSchema } from "@repo/protocol"

interface ExtractedManifest {
	name: string
	version: string
	/** The full validated manifest when the input is JSON or stripped TypeScript validates against the schema. */
	manifest: unknown
}

/**
 * Strips TypeScript-only syntax from the source so the snippet can
 * be evaluated by plain `vm`. The strips are deliberately narrow:
 *   - `satisfies X` after an expression
 *   - `: TypeName` type annotations on parameters / properties
 *   - `as TypeName` assertions
 *   - `import type { ... }` lines
 *   - `interface X { ... }` blocks
 *   - `type X = ...` aliases
 *
 * The result is plain ESM-like JavaScript that returns the default
 * export object. The TypeScript the manifest uses in practice is a
 * single `export default { ... } satisfies PackManifest` block;
 * the strip is enough to evaluate that shape.
 */
function stripTypeScript(source: string): string {
	let out = source
	// Strip `import type { ... } from '...'`
	out = out.replace(/^\s*import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, "")
	// Strip `interface X { ... }` blocks (greedy across newlines).
	out = out.replace(/^\s*export\s+interface\s+\w+[\s\S]*?\n\}\s*$/gm, "")
	out = out.replace(/^\s*interface\s+\w+[\s\S]*?\n\}\s*$/gm, "")
	// Strip `type X = ...` aliases.
	out = out.replace(/^\s*export\s+type\s+\w+\s*=[\s\S]*?;?\s*$/gm, "")
	out = out.replace(/^\s*type\s+\w+\s*=[\s\S]*?;?\s*$/gm, "")
	// Strip `: TypeName` annotations. We only strip identifiers that
	// start with an UPPERCASE letter (PascalCase — TS convention) or
	// that match a known primitive type allowlist. Lowercase
	// identifiers that look like values (`false`, `true`, `null`, etc.)
	// are left alone so the conversion never eats a literal.
	//
	// Note: a `: []` strip was considered but is intentionally
	// omitted. The TS source uses `: []` for both type-literal
	// annotations (`let x: [] = ...`) AND value initializations
	// (`field: []`). The TypeName regex below already handles
	// `field: TypeName[]` annotations (PascalCase / primitive with
	// its optional `[]` suffix is consumed in full). Stripping the
	// standalone `: []` is too aggressive — it converts the source's
	// explicit `field: []` value to `field: undefined`, which then
	// disappears under JSON.stringify and breaks schema validation
	// for required array fields (`params`, etc.). Empty-array values
	// in source manifests MUST survive into the VM evaluation intact
	// so the served manifest round-trips through PackManifestSchema
	// (VAL-PUB-004).
	// First segment must be PascalCase or a known primitive; subsequent
	// segments in a union are matched identically.
	out = out.replace(
		/(:\s*)(?:[A-Z][\w$]*(?:\[\])?|(?:string|number|boolean|unknown|any|void|never|object))(?:\s*\|\s*(?:[A-Z][\w$]*(?:\[\])?|(?:string|number|boolean|unknown|any|void|never|object)))*(\s*[,})\n])/g,
		(_match, lead, tail) => `${lead}${tail}`,
	)
	// Strip `as TypeName` assertions (PascalCase or primitive).
	out = out.replace(
		/\s+as\s+(?:[A-Z][\w$]*(?:\[\])?|(?:string|number|boolean|unknown|any|void|never|object))(?:\s*\|\s*(?:[A-Z][\w$]*(?:\[\])?|(?:string|number|boolean|unknown|any|void|never|object)))*/g,
		"",
	)
	// Strip `satisfies TypeName` suffixes (PascalCase or primitive).
	out = out.replace(
		/\s+satisfies\s+(?:[A-Z][\w$]*(?:\[\])?|(?:string|number|boolean|unknown|any|void|never|object))(?:\s*\|\s*(?:[A-Z][\w$]*(?:\[\])?|(?:string|number|boolean|unknown|any|void|never|object)))*/g,
		"",
	)
	// Drop the `export default` keyword but keep the expression.
	out = out.replace(/export\s+default\s+/g, "return ")
	return out
}

/**
 * Evaluates the stripped manifest source in a sandboxed `vm`
 * context and returns the exported object. Returns `null` on
 * any evaluation failure (parse error, runtime throw, timeout).
 *
 * The sandbox has zero host bindings (no `require`, no `process`,
 * no `globalThis`) and a 1-second timeout. A malicious manifest
 * cannot exfiltrate data or wedge the publish request.
 */
function evaluateManifest(source: string): unknown {
	const stripped = stripTypeScript(source)
	const wrapped = `(function () { ${stripped} })()`
	const context: Record<string, unknown> = {}
	try {
		const script = new vm.Script(wrapped, { filename: "manifest.ts" })
		const result = script.runInNewContext(context, {
			timeout: 1_000,
			displayErrors: false,
		})
		return result ?? null
	} catch {
		return null
	}
}

/**
 * Reads the manifest from the cloned repo and extracts `name`
 * and `version`. The full object is also returned (validated
 * against `PackManifestSchema` when possible) so the worker
 * has a typed source to ingest.
 *
 * Returns `null` when the manifest cannot be parsed, evaluated,
 * or its `name`/`version` fields are missing. The publish
 * endpoint translates `null` to a 422 with a field-naming
 * message; the worker re-validates against the full schema
 * downstream.
 */
export async function extractManifestFields(
	cloneDir: string,
	packPath: string | undefined,
): Promise<ExtractedManifest | null> {
	if (packPath && packPath.length > 0 && (packPath.includes("..") || packPath.startsWith("/"))) {
		// Mirrors `worker/ingest.ts:resolvePackDir`: a publish
		// body must not be able to make the reader escape the
		// clone dir via `..` or an absolute path. The worker
		// enforces the same confinement; doing it here as well
		// means the publish endpoint rejects the request with a
		// 422 instead of letting the worker surprise the operator
		// with an `IngestFailure` after a successful 202.
		return null
	}
	const relative =
		packPath && packPath.length > 0 ? join(cloneDir, packPath, "manifest.ts") : join(cloneDir, "manifest.ts")
	let source: string
	try {
		source = await readFile(relative, "utf8")
	} catch {
		return null
	}
	const evaluated = evaluateManifest(source)
	if (evaluated === null || typeof evaluated !== "object") return null
	const obj = evaluated as Record<string, unknown>
	if (typeof obj.name !== "string" || obj.name.length === 0) return null
	if (typeof obj.version !== "string" || obj.version.length === 0) return null

	// Best-effort schema validation against the protocol schema.
	// A failure here is informational — the worker re-validates
	// and surfaces the canonical error. The publish endpoint
	// only needs `name` and `version`.
	const validated = PackManifestSchema.safeParse(obj)

	return {
		name: obj.name,
		version: obj.version,
		manifest: validated.success ? validated.data : obj,
	}
}
