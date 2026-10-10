import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SlotDecl } from "@repo/protocol"
import { SlotKindSchema } from "@repo/protocol"
import Handlebars from "handlebars"
import { z } from "zod"
import { normalizeRelativePath } from "./contain.js"

const SLOT_BLOCK = /\{\{#slot\s+"([^"]+)"([^}]*)\}\}([\s\S]*?)\{\{\/slot\}\}/g

/** Stands in for a literal `{{` (written `\{{` in a template) while the template is checked and compiled. */
const LITERAL_BRACES = "\uE000BAKA-LBRACE\uE001"
/** The only helpers a template may call, each with exactly one param; see `json` and `jsonEscape` in docs/PACKS.md. */
const VALUE_HELPERS = new Set(["json", "jsonEscape"])
const BLOCK_HELPERS = new Set(["if", "each", "slot"])
const SLOT_HASH_KEYS = new Set(["kind", "max", "item", "schema"])

export class SlotTemplateError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SlotTemplateError"
	}
}

export function hashBytes(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex")
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	const obj = value as Record<string, unknown>
	const keys = Object.keys(obj).sort()
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`
}

function parseHash(raw: string): Record<string, string> {
	const out: Record<string, string> = {}
	const re = /([A-Za-z_][\w]*)=(?:"([^"]*)"|(\d+))/g
	for (const m of raw.matchAll(re)) {
		const key = m[1]
		if (!key) continue
		out[key] = m[2] ?? m[3] ?? ""
	}
	return out
}

/**
 * Turn each `\{{` (not itself preceded by a backslash) into a placeholder, so
 * generated code can contain a literal `{{`. Anything after the placeholder is
 * plain text, including the `}}` that closes it.
 */
function protectLiteralBraces(source: string, file: string): string {
	if (/[\uE000\uE001]/.test(source)) {
		throw new SlotTemplateError(`${file}: templates may not contain the private-use characters U+E000 and U+E001`)
	}
	return source.replace(/(?<!\\)\\\{\{/g, LITERAL_BRACES)
}

function restoreLiteralBraces(text: string): string {
	return text.replaceAll(LITERAL_BRACES, "{{")
}

type AstNode = hbs.AST.Node

/**
 * The Handlebars subset, checked on the parsed template and failing closed:
 * only text, comments, `{{param}}` (a path, never a literal), the value
 * helpers `{{json x}}` and `{{jsonEscape x}}`, and the blocks `if`, `each`,
 * and `slot` (with `{{else}}`) are allowed. Triple-stash, partials, decorators,
 * raw blocks, sub-expressions, block params, and every other helper are
 * rejected with a message naming the construct. Returns the ids of the
 * `{{#slot}}` blocks it found.
 */
export function assertHandlebarsSubset(source: string, file = "<template>"): string[] {
	let program: hbs.AST.Program
	try {
		program = Handlebars.parse(protectLiteralBraces(source, file))
	} catch (err) {
		if (err instanceof SlotTemplateError) throw err
		throw new SlotTemplateError(`${file}: not valid Handlebars: ${err instanceof Error ? err.message : String(err)}`)
	}
	const fail = (message: string): never => {
		throw new SlotTemplateError(`${file}: ${message}`)
	}
	const requirePath = (node: AstNode | undefined, what: string): hbs.AST.PathExpression => {
		if (node?.type !== "PathExpression") return fail(`${what} must be a plain parameter name`)
		return node as hbs.AST.PathExpression
	}
	const walk = (body: readonly AstNode[]): void => {
		for (const node of body) {
			switch (node.type) {
				case "ContentStatement":
				case "CommentStatement":
					break
				case "MustacheStatement": {
					const m = node as hbs.AST.MustacheStatement
					if (!m.escaped) fail("triple-stash {{{ }}} is forbidden")
					const path = requirePath(m.path, "an interpolation")
					const name = path.original
					if (m.params.length === 0 && !m.hash) {
						if (VALUE_HELPERS.has(name)) fail(`helper {{${name}}} needs exactly one parameter`)
						break
					}
					if (!VALUE_HELPERS.has(name)) fail(`custom helper {{${name} ...}} is forbidden`)
					if (m.params.length !== 1 || (m.hash && m.hash.pairs.length > 0)) {
						fail(`helper {{${name} ...}} takes exactly one parameter and no options`)
					}
					requirePath(m.params[0], `the parameter of {{${name} ...}}`)
					break
				}
				case "BlockStatement": {
					const b = node as hbs.AST.BlockStatement
					const name = requirePath(b.path, "a block").original
					if (!BLOCK_HELPERS.has(name)) fail(`block helper {{#${name}}} is forbidden`)
					if (b.program.blockParams && b.program.blockParams.length > 0)
						fail(`block params in {{#${name}}} are forbidden`)
					if (name === "slot") {
						const [id, ...rest] = b.params
						if (id?.type !== "StringLiteral" || rest.length > 0) fail(`{{#slot}} needs one quoted id`)
						for (const pair of b.hash?.pairs ?? []) {
							if (!SLOT_HASH_KEYS.has(pair.key)) fail(`slot option "${pair.key}" is not allowed`)
							if (pair.value.type !== "StringLiteral" && pair.value.type !== "NumberLiteral") {
								fail(`slot option "${pair.key}" must be a literal`)
							}
						}
						if (b.inverse) fail("{{#slot}} cannot have an {{else}}")
					} else {
						if (b.params.length !== 1) fail(`{{#${name}}} takes exactly one parameter`)
						requirePath(b.params[0], `the parameter of {{#${name}}}`)
						if (b.hash && b.hash.pairs.length > 0) fail(`{{#${name}}} takes no options`)
					}
					walk(b.program.body)
					if (b.inverse) walk(b.inverse.body)
					break
				}
				case "PartialStatement":
				case "PartialBlockStatement":
					fail("Handlebars partials are forbidden")
					break
				default:
					fail(`${node.type} is not allowed in a template`)
			}
		}
	}
	const slotIds: string[] = []
	const collect = (body: readonly AstNode[]): void => {
		for (const node of body) {
			if (node.type !== "BlockStatement") continue
			const b = node as hbs.AST.BlockStatement
			if ((b.path as hbs.AST.PathExpression).original === "slot")
				slotIds.push((b.params[0] as hbs.AST.StringLiteral).value)
			collect(b.program.body)
			if (b.inverse) collect(b.inverse.body)
		}
	}
	walk(program.body)
	collect(program.body)
	return slotIds
}

/** Handlebars compiles `{{log}}` and `{{lookup}}` as calls to built-ins unless told they are not helpers here. */
const COMPILE_OPTIONS = {
	noEscape: true,
	strict: false,
	knownHelpers: { log: false, lookup: false, with: false, unless: false },
} as const

/** A Handlebars environment with every built-in helper but `if` and `each` removed, plus `json` and `jsonEscape`. */
function templateEnvironment(): typeof Handlebars {
	const hb = Handlebars.create()
	for (const name of ["with", "unless", "lookup", "log"]) hb.unregisterHelper(name)
	hb.registerHelper("json", (value: unknown) => JSON.stringify(value === undefined ? null : value))
	hb.registerHelper("jsonEscape", (value: unknown) => JSON.stringify(String(value ?? "")).slice(1, -1))
	return hb
}

export function parseSlots(source: string, file: string): SlotDecl[] {
	const blockIds = assertHandlebarsSubset(source, file)
	const slots: SlotDecl[] = []
	const seen = new Set<string>()
	for (const m of source.matchAll(SLOT_BLOCK)) {
		const id = m[1]
		if (!id) continue
		if (seen.has(id)) {
			throw new SlotTemplateError(`${file}: duplicate slot id "${id}"`)
		}
		seen.add(id)
		const hash = parseHash(m[2] ?? "")
		const kindRaw = hash.kind ?? "prose"
		const kindParsed = SlotKindSchema.safeParse(kindRaw)
		if (!kindParsed.success) {
			throw new SlotTemplateError(`${file}: slot "${id}" has unknown kind "${kindRaw}"`)
		}
		const max = hash.max !== undefined ? Number(hash.max) : undefined
		if (max !== undefined && (!Number.isInteger(max) || max <= 0)) {
			throw new SlotTemplateError(`${file}: slot "${id}" max must be a positive integer`)
		}
		slots.push({
			id,
			kind: kindParsed.data,
			hint: (m[3] ?? "").trim(),
			file,
			max,
			item: hash.item,
			schemaPath: hash.schema,
		})
	}
	if (slots.length !== blockIds.length) {
		throw new SlotTemplateError(
			`${file}: every slot must be written {{#slot "id" kind="..."}}...{{/slot}} with a double-quoted id and no nesting`,
		)
	}
	return slots
}

export function slotResponseSchema(slot: SlotDecl): z.ZodType<{ value: unknown }> {
	switch (slot.kind) {
		case "prose": {
			let s = z.string().min(1)
			if (slot.max) s = s.max(slot.max)
			return z.object({ value: s })
		}
		case "ident": {
			let s = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)
			if (slot.max) s = s.max(slot.max)
			return z.object({ value: s })
		}
		case "list": {
			let arr = z.array(z.string().min(1))
			if (slot.max) arr = arr.max(slot.max)
			return z.object({ value: arr })
		}
		case "json":
			return z.object({ value: z.record(z.string(), z.unknown()) })
	}
}

export function formatSlotValue(slot: SlotDecl, value: unknown): string {
	if (slot.kind === "list" && Array.isArray(value)) {
		return value.map((item) => `- ${item}`).join("\n")
	}
	if (slot.kind === "json" && value !== null && typeof value === "object") {
		return JSON.stringify(value, null, "\t")
	}
	return String(value ?? "")
}

/**
 * Substitute filled slots, then interpolate params / if / each. `context` is
 * what the template can see: the recipe's params plus `data`, the pack's
 * data files. Slot bodies are inserted as text, never as template source, so
 * a fill cannot inject Handlebars; a `{{` in a fill comes out literally, as
 * does a `\{{` in the template.
 */
export function renderTemplate(
	source: string,
	context: Record<string, unknown>,
	fills: Record<string, unknown>,
): string {
	assertHandlebarsSubset(source)
	const protectedSource = protectLiteralBraces(source, "<render>")
	const decls = parseSlots(source, "<render>")
	const replaced = protectedSource.replace(SLOT_BLOCK, (_all, id: string) => {
		if (!(id in fills)) {
			throw new SlotTemplateError(`slot "${id}" has no fill`)
		}
		const decl = decls.find((s) => s.id === id)
		if (!decl) {
			throw new SlotTemplateError(`slot "${id}" disappeared during render`)
		}
		return formatSlotValue(decl, fills[id]).replaceAll("{{", LITERAL_BRACES)
	})
	return restoreLiteralBraces(templateEnvironment().compile(replaced, COMPILE_OPTIONS)(context))
}

/**
 * Render a template's output path from the context (params and `data`) and return it normalized
 * and contained: a rendered path that is absolute, has a `..` segment, or
 * otherwise cannot be a project-relative path fails with `path-escape`, so a
 * param like `../../x` never reaches the file system.
 */
export function interpolatePath(rel: string, context: Record<string, unknown>): string {
	assertHandlebarsSubset(rel, rel)
	const rendered = templateEnvironment().compile(protectLiteralBraces(rel, rel), COMPILE_OPTIONS)(context)
	return normalizeRelativePath(restoreLiteralBraces(rendered))
}

function discoverHbsFiles(dir: string): string[] {
	if (!existsSync(dir)) return []
	const results: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			results.push(...discoverHbsFiles(fullPath))
		} else if (entry.isFile() && entry.name.endsWith(".hbs")) {
			results.push(fullPath)
		}
	}
	return results.sort()
}

function relativePosix(base: string, target: string): string {
	return target.slice(base.length).split(/[/\\]/).filter(Boolean).join("/")
}

/**
 * The directive a template may carry on its very first line, as a Handlebars
 * comment that never reaches the output:
 *
 *   {{!-- @baka when="vitest" mode="0755" --}}
 *
 * - `when` makes the file conditional: it is written only if the expression
 *   holds for the params (`name`, `!name`, `kind=lib`, `kind!=lib`; see `evaluateWhen`).
 * - `mode` is the file's permission bits, three or four octal digits, setuid/setgid/sticky excluded.
 */
interface TemplateDirective {
	when?: string
	/** Normalized to four octal digits, e.g. `"0755"`. */
	mode?: string
}

const DIRECTIVE_AT_START = /^\{\{!--\s*@baka\b/
const DIRECTIVE = /^\{\{!--\s*@baka\b([\s\S]*?)--\}\}[ \t]*(?:\r?\n)?/
const WHEN = /^(!)?\s*([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\s*(?:(!?=)\s*(\S.*?))?\s*$/

function parseWhen(expr: string, file: string): { negate: boolean; path: string[]; op?: "=" | "!="; literal?: string } {
	const m = WHEN.exec(expr)
	if (!m || (m[1] && m[3])) {
		throw new SlotTemplateError(
			`${file}: when="${expr}" is not valid; use a parameter name, !name, name=value, or name!=value`,
		)
	}
	const literal = m[4]?.replace(/^'(.*)'$/, "$1")
	return { negate: m[1] === "!", path: (m[2] as string).split("."), op: m[3] as "=" | "!=" | undefined, literal }
}

function truthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0
	return Boolean(value)
}

/** Whether a template's `when` expression holds for `context` (params plus `data`). Truthiness is Handlebars' `if`: empty arrays, 0, "" and null are false. */
export function evaluateWhen(expr: string, context: Record<string, unknown>): boolean {
	const parsed = parseWhen(expr, "<when>")
	let value: unknown = context
	for (const key of parsed.path) {
		value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
	}
	if (parsed.op === "=") return value !== undefined && value !== null && String(value) === parsed.literal
	if (parsed.op === "!=") return value === undefined || value === null || String(value) !== parsed.literal
	return parsed.negate ? !truthy(value) : truthy(value)
}

function parseDirective(source: string, file: string): { directive: TemplateDirective; body: string } {
	const rest = DIRECTIVE_AT_START.test(source) ? source : null
	if (rest === null) {
		if (/\{\{!--\s*@baka\b/.test(source))
			throw new SlotTemplateError(`${file}: the @baka directive must be the first line of the template`)
		return { directive: {}, body: source }
	}
	const m = DIRECTIVE.exec(source)
	if (!m) throw new SlotTemplateError(`${file}: the @baka directive is not closed with --}}`)
	const directive: TemplateDirective = {}
	const pairs = /\s*([A-Za-z]+)="([^"]*)"/y
	let index = 0
	const inner = m[1] as string
	while (index < inner.length && inner.slice(index).trim() !== "") {
		pairs.lastIndex = index
		const pair = pairs.exec(inner)
		if (!pair)
			throw new SlotTemplateError(`${file}: the @baka directive must be key="value" pairs, got: ${inner.trim()}`)
		index = pairs.lastIndex
		const [, key, value] = pair as unknown as [string, string, string]
		if (key !== "when" && key !== "mode")
			throw new SlotTemplateError(`${file}: unknown @baka directive key "${key}" (expected when or mode)`)
		if (directive[key] !== undefined) throw new SlotTemplateError(`${file}: @baka directive key "${key}" given twice`)
		if (key === "when") {
			parseWhen(value, file)
			directive.when = value
		} else {
			if (!/^[0-7]{3,4}$/.test(value) || (Number.parseInt(value, 8) & 0o7000) !== 0) {
				throw new SlotTemplateError(
					`${file}: mode="${value}" must be three or four octal digits without setuid, setgid, or sticky bits`,
				)
			}
			directive.mode = value.padStart(4, "0")
		}
	}
	return { directive, body: source.slice(m[0].length) }
}

interface TemplateFile {
	abs: string
	/** Path under `templates/`, POSIX, with the `.hbs` suffix. */
	rel: string
	/** The file as written, directive included. */
	source: string
	/** The part that renders: `source` without its directive. */
	body: string
	directive: TemplateDirective
}

export function parseRecipeTemplates(templatesDir: string): {
	files: TemplateFile[]
	slots: SlotDecl[]
} {
	const files = discoverHbsFiles(templatesDir).map((abs) => {
		const rel = relativePosix(templatesDir, abs)
		const source = readFileSync(abs, "utf-8")
		return { abs, rel, source, ...parseDirective(source, rel) }
	})
	const slots: SlotDecl[] = []
	const seen = new Set<string>()
	for (const file of files) {
		const parsed = parseSlots(file.source, file.rel)
		for (const slot of parsed) {
			if (seen.has(slot.id)) {
				throw new SlotTemplateError(`duplicate slot id "${slot.id}" across templates`)
			}
			seen.add(slot.id)
			slots.push(slot)
		}
	}
	return { files, slots }
}

export function slotCacheKey(input: {
	templateHash: string
	slotId: string
	paramsHash: string
	model: string
}): string {
	return hashBytes(`${input.templateHash}\0${input.slotId}\0${input.paramsHash}\0${input.model}`)
}

/**
 * Model-independent identity of one slot fill (see SlotRecord.key): the same
 * template bytes, slot id, and params always yield the same key, whichever
 * model produced the value.
 */
export function slotRecordKey(input: { templateHash: string; slotId: string; paramsHash: string }): string {
	return hashBytes(`${input.templateHash}\0${input.slotId}\0${input.paramsHash}`)
}

/**
 * Identity of a slot fill that holds for any params: the same template bytes
 * and slot id always yield the same key. It is what a `match: "template"`
 * record carries, and it is tagged so it never equals a params-keyed identity.
 */
export function slotTemplateKey(input: { templateHash: string; slotId: string }): string {
	return hashBytes(`template\0${input.templateHash}\0${input.slotId}`)
}
