import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type {
	ActionCompensation,
	ChangesetEntry,
	LLMProvider,
	LLMRequest,
	SlotDecl,
	SlotMode,
	SlotRecord,
} from "@repo/protocol"
import type { z } from "zod"
import { ActionError } from "./errors.js"
import type { SlotStore } from "./slot-cache.js"
import {
	canonicalJson,
	hashBytes,
	interpolatePath,
	parseActionTemplates,
	renderTemplate,
	SlotTemplateError,
	slotCacheKey,
	slotRecordKey,
	slotResponseSchema,
} from "./slots.js"
import { compareUtf8 } from "./tree-hash.js"

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
	let content: unknown
	try {
		content = (await provider.chat<{ value: unknown }>(request)).content
	} catch (err) {
		throw new ActionError(
			"slot-provider-error",
			`slot "${slot.id}": the provider failed: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	const parsed = schema.safeParse(content)
	if (!parsed.success) {
		throw new ActionError("slot-fill-invalid", `slot "${slot.id}" fill did not match schema: ${parsed.error.message}`)
	}
	return parsed.data.value
}

/**
 * Find the record a replay fills `slot` from. A record for the same slot id
 * whose key differs was taken against another template or other params, so
 * it is rejected as stale rather than silently reused.
 */
function replayRecord(slot: SlotDecl, key: string, records: readonly SlotRecord[]): SlotRecord {
	const sameId = records.filter((r) => r.id === slot.id)
	if (sameId.length === 0) {
		throw new ActionError("slot-record-missing", `replay: no record for slot "${slot.id}"; no model call was made`)
	}
	const record = sameId.find((r) => r.key === key)
	if (!record) {
		throw new ActionError(
			"slot-record-stale",
			`replay: the record for slot "${slot.id}" was taken against a different template or different params (key mismatch)`,
		)
	}
	const parsed = slotResponseSchema(slot).safeParse({ value: record.value })
	if (!parsed.success) {
		throw new ActionError(
			"slot-fill-invalid",
			`replay: the record for slot "${slot.id}" does not match its schema: ${parsed.error.message}`,
		)
	}
	return { ...record, source: "replay" }
}

export interface PlanTemplatesOptions {
	/** Project root: where the files would be written and where existing files are compared. */
	root: string
	templatesDir: string
	params: Record<string, unknown>
	provider: LLMProvider | null
	model: string
	/** Slot cache: read before a model call, written after one (unless `persist` is false). */
	store: SlotStore
	/** Write fresh fills to the store. False for dry runs, which must not touch the disk. */
	persist: boolean
	/** How slot values are obtained; see SlotModeSchema. */
	slotMode: SlotMode
	/** The records a `replay` draws from. */
	records: readonly SlotRecord[]
}

export interface PlannedFile extends ChangesetEntry {
	/** The bytes this template renders to. */
	content: string
	/** The bytes found on disk before the run, when the path already existed. */
	previous?: Buffer
}

export interface TemplatePlan {
	files: PlannedFile[]
	slots: SlotRecord[]
}

/**
 * Resolve every slot, render every template, and compare each target with the
 * disk. Nothing is written here (apart from slot-cache writes when `persist`),
 * so the same plan serves a real run and a dry run.
 */
export async function planTemplates(opts: PlanTemplatesOptions): Promise<TemplatePlan> {
	const { files, slots } = parseActionTemplates(opts.templatesDir)
	const paramsHash = hashBytes(canonicalJson(opts.params))
	const fills: Record<string, unknown> = {}
	const records: SlotRecord[] = []

	for (const slot of slots) {
		const template = files.find((f) => f.rel === slot.file)
		if (!template) {
			throw new ActionError("template-invalid", `slot "${slot.id}" references missing template ${slot.file}`)
		}
		const templateHash = hashBytes(template.source)
		const recordKey = slotRecordKey({ templateHash, slotId: slot.id, paramsHash })
		const key = slotCacheKey({ templateHash, slotId: slot.id, paramsHash, model: opts.model })
		const manualKey = slotCacheKey({ templateHash, slotId: slot.id, paramsHash, model: "manual" })

		if (opts.slotMode === "replay") {
			const replayed = replayRecord(slot, recordKey, opts.records)
			fills[slot.id] = replayed.value
			records.push(replayed)
			continue
		}

		const hit = opts.slotMode === "live" ? (opts.store.read(key) ?? opts.store.read(manualKey)) : null
		if (hit) {
			fills[slot.id] = hit.value
			records.push({
				id: slot.id,
				key: recordKey,
				model: hit.model,
				value: hit.value as SlotRecord["value"],
				source: "cache",
			})
			continue
		}
		if (!opts.provider) {
			throw new ActionError(
				"slot-no-provider",
				`slot "${slot.id}" is empty and no LLMProvider was injected. Run \`baka init\` to configure the worker role.`,
			)
		}
		const value = await fillSlot(slot, opts.params, opts.provider, opts.model)
		fills[slot.id] = value
		if (opts.persist) {
			opts.store.write({
				key,
				slotId: slot.id,
				kind: slot.kind,
				value,
				model: opts.model,
				templateHash,
				paramsHash,
			})
		}
		records.push({ id: slot.id, key: recordKey, model: opts.model, value: value as SlotRecord["value"], source: "llm" })
	}

	const planned = new Map<string, PlannedFile>()
	for (const file of files) {
		const path = interpolatePath(file.rel.replace(/\.hbs$/, ""), opts.params)
		if (planned.has(path)) {
			throw new ActionError("template-invalid", `two templates render to the same path "${path}"`)
		}
		let content: string
		try {
			content = renderTemplate(file.source, opts.params, fills)
		} catch (err) {
			if (err instanceof SlotTemplateError) throw new ActionError("template-invalid", err.message)
			throw err
		}
		const contentHash = hashBytes(content)
		const abs = join(opts.root, path)
		if (!existsSync(abs)) {
			planned.set(path, { path, op: "create", contentHash, content })
			continue
		}
		if (!statSync(abs).isFile()) {
			throw new ActionError("template-invalid", `"${path}" exists and is not a regular file`)
		}
		const previous = readFileSync(abs)
		if (hashBytes(previous) === contentHash) {
			planned.set(path, { path, op: "unchanged", contentHash, reason: "identical", content, previous })
		} else {
			planned.set(path, {
				path,
				op: "skip",
				contentHash: hashBytes(previous),
				reason: "already-exists",
				content,
				previous,
			})
		}
	}
	return {
		files: [...planned.values()].sort((a, b) => compareUtf8(a.path, b.path)),
		slots: records,
	}
}

/** Undo what `applyPlan` did (and what a failed side-effect action left behind). */
export function revertFiles(root: string, compensation: Pick<ActionCompensation, "created" | "overwritten">): void {
	for (const rel of compensation.created) rmSync(join(root, rel), { force: true })
	for (const { path, contentBase64 } of compensation.overwritten) {
		writeFileSync(join(root, path), Buffer.from(contentBase64, "base64"))
	}
}

/** Write every create/update in the plan. On a failed write, revert what was written and rethrow. */
export function applyPlan(root: string, plan: TemplatePlan): Pick<ActionCompensation, "created" | "overwritten"> {
	const done: Pick<ActionCompensation, "created" | "overwritten"> = { created: [], overwritten: [] }
	try {
		for (const file of plan.files) {
			if (file.op !== "create" && file.op !== "update") continue
			const abs = join(root, file.path)
			mkdirSync(dirname(abs), { recursive: true })
			if (file.op === "update" && file.previous) {
				done.overwritten.push({ path: file.path, contentBase64: file.previous.toString("base64") })
			}
			writeFileSync(abs, file.content, "utf-8")
			if (file.op === "create") done.created.push(file.path)
		}
	} catch (err) {
		revertFiles(root, done)
		throw err
	}
	return done
}
