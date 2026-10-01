import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, posix } from "node:path"
import type { SlotDecl } from "@repo/protocol"
import { SlotKindSchema } from "@repo/protocol"
import Handlebars from "handlebars"
import { z } from "zod"

const SLOT_BLOCK = /\{\{#slot\s+"([^"]+)"([^}]*)\}\}([\s\S]*?)\{\{\/slot\}\}/g

const FORBIDDEN_BLOCK = /\{\{#(unless|with|lookup|each as|[\w-]+)/g
const ALLOWED_BLOCKS = new Set(["if", "each", "slot"])
const TRIPLE_STASH = /\{\{\{/
const PARTIAL = /\{\{>/
const CUSTOM_HELPER_CALL = /\{\{(?!else|#|\/|!--|else\s)([A-Za-z_][\w-]*)\s+[^\s}]/

export class SlotTemplateError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SlotTemplateError"
	}
}

export function hashBytes(input: string): string {
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

export function assertHandlebarsSubset(source: string, file = "<template>"): void {
	if (TRIPLE_STASH.test(source)) {
		throw new SlotTemplateError(`${file}: triple-stash {{{ }}} is forbidden`)
	}
	if (PARTIAL.test(source)) {
		throw new SlotTemplateError(`${file}: Handlebars partials are forbidden`)
	}
	const custom = CUSTOM_HELPER_CALL.exec(source)
	if (custom?.[1] && !["if", "each"].includes(custom[1])) {
		throw new SlotTemplateError(`${file}: custom helper {{${custom[1]} ...}} is forbidden`)
	}
	for (const m of source.matchAll(FORBIDDEN_BLOCK)) {
		const name = m[1]
		if (!name) continue
		if (!ALLOWED_BLOCKS.has(name.split(/\s/)[0] ?? "")) {
			throw new SlotTemplateError(`${file}: block helper {{#${name}}} is forbidden`)
		}
	}
}

export function parseSlots(source: string, file: string): SlotDecl[] {
	assertHandlebarsSubset(source, file)
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
			return z.object({ value: z.record(z.unknown()) })
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
 * Substitute filled slots, then interpolate params / if / each.
 * Slot bodies are inserted as raw text with `{{` escaped so fills cannot
 * inject Handlebars.
 */
export function renderTemplate(
	source: string,
	params: Record<string, unknown>,
	fills: Record<string, unknown>,
): string {
	assertHandlebarsSubset(source)
	const replaced = source.replace(SLOT_BLOCK, (_all, id: string, _hash: string, _body: string) => {
		if (!(id in fills)) {
			throw new SlotTemplateError(`slot "${id}" has no fill`)
		}
		const slots = parseSlots(source, "<render>")
		const decl = slots.find((s) => s.id === id)
		if (!decl) {
			throw new SlotTemplateError(`slot "${id}" disappeared during render`)
		}
		const text = formatSlotValue(decl, fills[id])
		return text.replace(/\{\{/g, "\\{\\{")
	})
	const hb = Handlebars.create()
	return hb.compile(replaced, { noEscape: true, strict: false })(params)
}

export function interpolatePath(rel: string, params: Record<string, unknown>): string {
	const hb = Handlebars.create()
	const rendered = hb.compile(rel, { noEscape: true, strict: false })(params)
	return posix.normalize(rendered).replace(/^\.\//, "")
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

export function parseActionTemplates(templatesDir: string): {
	files: Array<{ abs: string; rel: string; source: string }>
	slots: SlotDecl[]
} {
	const files = discoverHbsFiles(templatesDir).map((abs) => ({
		abs,
		rel: relativePosix(templatesDir, abs),
		source: readFileSync(abs, "utf-8"),
	}))
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

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true })
}

export function writeTextFile(path: string, content: string): void {
	ensureDir(join(path, ".."))
	writeFileSync(path, content, "utf-8")
}
