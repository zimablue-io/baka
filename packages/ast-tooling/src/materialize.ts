import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, posix } from "node:path"
import type {
	ActionCompensation,
	ChangesetEntry,
	LLMProvider,
	LLMRequest,
	OnExisting,
	SlotDecl,
	SlotMode,
	SlotRecord,
} from "@repo/protocol"
import type { z } from "zod"
import { ensureDirectory, removeCreatedDirectories, resolveContained } from "./contain.js"
import { ActionError } from "./errors.js"
import type { SlotStore } from "./slot-cache.js"
import {
	canonicalJson,
	evaluateWhen,
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

/** A template's output path, with subset errors reported as `template-invalid`. */
function outputPath(file: { rel: string }, context: Record<string, unknown>): string {
	try {
		return interpolatePath(file.rel.replace(/\.hbs$/, ""), context)
	} catch (err) {
		if (err instanceof SlotTemplateError) throw new ActionError("template-invalid", err.message)
		throw err
	}
}

export interface PlanTemplatesOptions {
	/** Project root: where the files would be written and where existing files are compared. */
	root: string
	templatesDir: string
	params: Record<string, unknown>
	/** The module's `data/*.json` files; templates read them as `data.<name>`. */
	data: Readonly<Record<string, unknown>>
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
	/** What to do with targets that already exist; see OnExistingSchema. */
	onExisting: OnExisting
}

export interface PlannedFile extends ChangesetEntry {
	/** The bytes this template renders to. */
	content: string
	/** The bytes found on disk before the run, when the path already existed. */
	previous?: Buffer
	/** The permission bits found on disk before an `update`, so a rollback can restore them. */
	previousMode?: string
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
	let parsed: ReturnType<typeof parseActionTemplates>
	try {
		parsed = parseActionTemplates(opts.templatesDir)
	} catch (err) {
		if (err instanceof SlotTemplateError) throw new ActionError("template-invalid", err.message)
		throw err
	}
	// What a template can see: the params and the module's data files.
	const context: Record<string, unknown> = { ...opts.params, data: opts.data }
	// A template whose `when` does not hold is not part of this run: it writes nothing and its slots are never filled.
	const files = parsed.files.filter((f) => f.directive.when === undefined || evaluateWhen(f.directive.when, context))
	const slots = parsed.slots.filter((slot) => files.some((f) => f.rel === slot.file))
	// Everything decidable from the params and the disk alone is checked up front, so a bad
	// target fails the run before any slot is filled or any model is asked.
	const targets = new Map<string, string>() // output path -> template it came from
	for (const file of files) {
		const path = outputPath(file, context)
		const other = targets.get(path)
		if (other !== undefined) {
			throw new ActionError("template-invalid", `templates ${other} and ${file.rel} render to the same path "${path}"`)
		}
		targets.set(path, file.rel)
		const abs = resolveContained(opts.root, path)
		if (existsSync(abs) && !statSync(abs).isFile()) {
			throw new ActionError("template-invalid", `"${path}" exists and is not a regular file`)
		}
	}
	if (opts.onExisting === "fail") {
		const existing = [...targets.keys()].filter((path) => existsSync(resolveContained(opts.root, path)))
		if (existing.length > 0) {
			throw new ActionError(
				"target-exists",
				`onExisting is "fail" and these targets already exist: ${existing.join(", ")}`,
			)
		}
	}
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
		const path = outputPath(file, context)
		let content: string
		try {
			content = renderTemplate(file.body, context, fills)
		} catch (err) {
			if (err instanceof SlotTemplateError) throw new ActionError("template-invalid", err.message)
			throw err
		}
		const contentHash = hashBytes(content)
		const mode = file.directive.mode
		const withMode = mode ? { mode } : {}
		const abs = resolveContained(opts.root, path)
		if (!existsSync(abs)) {
			planned.set(path, { path, op: "create", contentHash, ...withMode, content })
			continue
		}
		const previous = readFileSync(abs)
		const previousMode = formatMode(statSync(abs).mode)
		const sameBytes = hashBytes(previous) === contentHash
		if (sameBytes && (!mode || previousMode === mode)) {
			planned.set(path, { path, op: "unchanged", contentHash, reason: "identical", ...withMode, content, previous })
		} else if (opts.onExisting === "overwrite") {
			planned.set(path, { path, op: "update", contentHash, ...withMode, content, previous, previousMode })
		} else {
			planned.set(path, {
				path,
				op: "skip",
				contentHash: hashBytes(previous),
				reason: "already-exists",
				...(mode ? { mode: previousMode } : {}),
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

/** Permission bits as four octal digits. */
export function formatMode(mode: number): string {
	return (mode & 0o777).toString(8).padStart(4, "0")
}

export type Rollback = Pick<ActionCompensation, "created" | "createdDirs" | "overwritten">

/**
 * Undo what `applyPlan` did (and what a failed side-effect action left
 * behind): delete the files the run created, restore the files it
 * overwrote, then remove the directories it created, deepest first, once
 * they are empty.
 *
 * The compensation may come from outside (a stored receipt), so every path
 * in it is checked against the project root before anything is touched; one
 * path that escapes refuses the whole rollback.
 */
export function revertFiles(root: string, compensation: Rollback): void {
	const created = compensation.created.map((rel) => resolveContained(root, rel))
	const restore = compensation.overwritten.map((entry) => ({
		abs: resolveContained(root, entry.path),
		bytes: Buffer.from(entry.contentBase64, "base64"),
		mode: entry.mode,
	}))
	const dirs = compensation.createdDirs.map((rel) => {
		resolveContained(root, rel)
		return rel
	})
	for (const abs of created) rmSync(abs, { force: true })
	for (const { abs, bytes, mode } of restore) {
		mkdirSync(dirname(abs), { recursive: true })
		writeFileSync(abs, bytes)
		if (mode) chmodSync(abs, Number.parseInt(mode, 8))
	}
	removeCreatedDirectories(root, dirs)
}

/** Write every create/update in the plan. On a failed write, revert what was written and rethrow. */
export function applyPlan(root: string, plan: TemplatePlan): Rollback {
	const done: Rollback = { created: [], createdDirs: [], overwritten: [] }
	try {
		for (const file of plan.files) {
			if (file.op !== "create" && file.op !== "update") continue
			const abs = resolveContained(root, file.path)
			ensureDirectory(root, posix.dirname(file.path), done.createdDirs)
			if (file.op === "update" && file.previous) {
				done.overwritten.push({
					path: file.path,
					contentBase64: file.previous.toString("base64"),
					...(file.mode && file.previousMode ? { mode: file.previousMode } : {}),
				})
			}
			writeFileSync(abs, file.content, "utf-8")
			if (file.mode) chmodSync(abs, Number.parseInt(file.mode, 8))
			if (file.op === "create") done.created.push(file.path)
		}
	} catch (err) {
		revertFiles(root, done)
		throw err
	}
	return done
}
