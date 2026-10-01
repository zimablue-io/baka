import { existsSync } from "node:fs"
import { join } from "node:path"
import type { LLMProvider, LLMRequest, SlotDecl } from "@repo/protocol"
import type { z } from "zod"
import type { SlotStore } from "./slot-cache.js"
import {
	canonicalJson,
	hashBytes,
	interpolatePath,
	parseActionTemplates,
	renderTemplate,
	SlotTemplateError,
	slotCacheKey,
	slotResponseSchema,
	writeTextFile,
} from "./slots.js"

export interface MaterializeOptions {
	cwd: string
	templatesDir: string
	params: Record<string, unknown>
	/** User-supplied params for the cache key. Defaults to `params`. */
	cacheParams?: Record<string, unknown>
	provider: LLMProvider | null
	model: string
	/** Slot cache. Reads happen before a model call; fills are written back. */
	store: SlotStore
	refill?: boolean
	manualFills?: Record<string, unknown>
}

export interface MaterializeResult {
	written: string[]
	skipped: string[]
	slots: Array<{
		id: string
		kind: SlotDecl["kind"]
		file: string
		cached: boolean
		source: "cache" | "llm" | "manual"
	}>
	tree: Record<string, string>
}

const SLOT_SYSTEM =
	"Fill one named slot. Return JSON only matching the schema. Do not invent document structure. Do not add headings the hint did not ask for."

export async function fillSlot(
	slot: SlotDecl,
	params: Record<string, unknown>,
	provider: LLMProvider,
	model: string,
): Promise<unknown> {
	const schema = slotResponseSchema(slot)
	const request: LLMRequest = {
		model,
		messages: [
			{ role: "system", content: SLOT_SYSTEM },
			{
				role: "user",
				content: [
					`id: ${slot.id}`,
					`kind: ${slot.kind}`,
					slot.max !== undefined ? `max: ${slot.max}` : "",
					slot.item ? `item: ${slot.item}` : "",
					`hint: ${slot.hint || "(none)"}`,
					`params: ${canonicalJson(params)}`,
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
		responseSchema: schema as z.ZodType<unknown>,
		temperature: 0,
		maxTokens: 1024,
		providerOptions: { chat_template_kwargs: { enable_thinking: false } },
	}
	const response = await provider.chat<{ value: unknown }>(request)
	const parsed = schema.safeParse(response.content)
	if (!parsed.success) {
		throw new SlotTemplateError(`slot "${slot.id}" fill did not match schema: ${parsed.error.message}`)
	}
	return parsed.data.value
}

export async function materializeTemplates(opts: MaterializeOptions): Promise<MaterializeResult> {
	const { files, slots } = parseActionTemplates(opts.templatesDir)
	const paramsHash = hashBytes(canonicalJson(opts.cacheParams ?? opts.params))
	const fills: Record<string, unknown> = { ...(opts.manualFills ?? {}) }
	const slotReport: MaterializeResult["slots"] = []

	for (const slot of slots) {
		if (slot.id in fills) {
			slotReport.push({ id: slot.id, kind: slot.kind, file: slot.file, cached: false, source: "manual" })
			continue
		}
		const template = files.find((f) => f.rel === slot.file)
		if (!template) {
			throw new SlotTemplateError(`slot "${slot.id}" references missing template ${slot.file}`)
		}
		const templateHash = hashBytes(template.source)
		const key = slotCacheKey({
			templateHash,
			slotId: slot.id,
			paramsHash,
			model: opts.model,
		})
		const manualKey = slotCacheKey({
			templateHash,
			slotId: slot.id,
			paramsHash,
			model: "manual",
		})
		if (!opts.refill) {
			const hit = opts.store.read(key) ?? opts.store.read(manualKey)
			if (hit) {
				fills[slot.id] = hit.value
				slotReport.push({ id: slot.id, kind: slot.kind, file: slot.file, cached: true, source: "cache" })
				continue
			}
		}
		if (!opts.provider) {
			throw new Error(
				`slot "${slot.id}" is empty and no LLMProvider was injected. Run \`baka init\` to configure the worker role.`,
			)
		}
		const value = await fillSlot(slot, opts.params, opts.provider, opts.model)
		fills[slot.id] = value
		opts.store.write({
			key,
			slotId: slot.id,
			kind: slot.kind,
			value,
			model: opts.model,
			templateHash,
			paramsHash,
		})
		slotReport.push({ id: slot.id, kind: slot.kind, file: slot.file, cached: false, source: "llm" })
	}

	const written: string[] = []
	const skipped: string[] = []
	const tree: Record<string, string> = {}

	for (const file of files) {
		const outRel = interpolatePath(file.rel.replace(/\.hbs$/, ""), opts.params)
		const outAbs = join(opts.cwd, outRel)
		const content = renderTemplate(file.source, opts.params, fills)
		tree[outRel] = content
		if (existsSync(outAbs)) {
			skipped.push(outRel)
			continue
		}
		writeTextFile(outAbs, content)
		written.push(outRel)
	}

	return { written, skipped, slots: slotReport, tree }
}
