// A slot record that matches the template, not the params: what a catalog ships as a usable default.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BAKA_DEFAULT_WORKER_MODEL, type SlotRecord, SlotRecordSchema } from "@repo/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { planTemplates } from "./materialize.js"
import { createMemorySlotStore } from "./slot-cache.js"
import { canonicalJson, hashBytes, slotRecordKey, slotTemplateKey } from "./slots.js"

const cleanup: string[] = []
afterEach(() => {
	for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

const NOTE = '# {{title}}\n{{#slot "blurb" kind="prose" max=40}}one line{{/slot}}\n'

function project(template = NOTE): { dir: string; templates: string } {
	const dir = mkdtempSync(join(tmpdir(), "baka-slot-fixture-"))
	cleanup.push(dir)
	const templates = join(dir, "templates")
	mkdirSync(templates, { recursive: true })
	writeFileSync(join(templates, "note.md.hbs"), template)
	return { dir, templates }
}

function templateRecord(value: string, template = NOTE): SlotRecord {
	return {
		id: "blurb",
		key: slotTemplateKey({ templateHash: hashBytes(template), slotId: "blurb" }),
		match: "template",
		model: "manual",
		value,
		source: "replay",
	}
}

function paramsRecord(params: Record<string, unknown>, value: string): SlotRecord {
	return {
		id: "blurb",
		key: slotRecordKey({
			templateHash: hashBytes(NOTE),
			slotId: "blurb",
			paramsHash: hashBytes(canonicalJson(params)),
		}),
		model: "manual",
		value,
		source: "replay",
	}
}

async function replay(dir: string, templates: string, params: Record<string, unknown>, records: SlotRecord[]) {
	return planTemplates({
		root: dir,
		templatesDir: templates,
		data: {},
		params,
		provider: null,
		model: BAKA_DEFAULT_WORKER_MODEL,
		store: createMemorySlotStore(),
		persist: false,
		slotMode: "replay",
		records,
		onExisting: "skip",
	})
}

describe("template-matched slot records", () => {
	it("fill the slot whatever the params are", async () => {
		const { dir, templates } = project()
		const records = [templateRecord("A default.")]
		for (const title of ["One", "Two"]) {
			const plan = await replay(dir, templates, { title }, records)
			expect(plan.files.map((f) => f.content)).toEqual([`# ${title}\nA default.\n`])
			expect(plan.slots).toEqual([{ ...records[0], source: "replay" }])
		}
	})

	it("are stale once the template's bytes change", async () => {
		const changed = `${NOTE}more\n`
		const { dir, templates } = project(changed)
		await expect(replay(dir, templates, { title: "X" }, [templateRecord("Old.")])).rejects.toMatchObject({
			code: "slot-record-stale",
		})
	})

	it("lose to a record taken against exactly these params", async () => {
		const { dir, templates } = project()
		const records = [templateRecord("Default."), paramsRecord({ title: "Ada" }, "Specific.")]
		const ada = await replay(dir, templates, { title: "Ada" }, records)
		expect(ada.files[0]?.content).toBe("# Ada\nSpecific.\n")
		const grace = await replay(dir, templates, { title: "Grace" }, records)
		expect(grace.files[0]?.content).toBe("# Grace\nDefault.\n")
	})

	it("are not confused with a params record whose key differs", async () => {
		const { dir, templates } = project()
		await expect(
			replay(dir, templates, { title: "Grace" }, [paramsRecord({ title: "Ada" }, "Specific.")]),
		).rejects.toMatchObject({
			code: "slot-record-stale",
		})
	})

	it("do not collide with the params-keyed identity of the same slot", () => {
		const templateHash = hashBytes(NOTE)
		const keys = new Set([
			slotTemplateKey({ templateHash, slotId: "blurb" }),
			slotRecordKey({ templateHash, slotId: "blurb", paramsHash: hashBytes(canonicalJson({})) }),
			slotRecordKey({ templateHash, slotId: "blurb", paramsHash: "" }),
		])
		expect(keys.size).toBe(3)
	})
})

describe("SlotRecordSchema match", () => {
	const base = { id: "blurb", key: "k", model: "manual", value: "v", source: "replay" }
	it("accepts params and template, and no match at all", () => {
		expect(SlotRecordSchema.safeParse(base).success).toBe(true)
		expect(SlotRecordSchema.safeParse({ ...base, match: "params" }).success).toBe(true)
		expect(SlotRecordSchema.safeParse({ ...base, match: "template" }).success).toBe(true)
	})
	it("rejects any other value", () => {
		expect(SlotRecordSchema.safeParse({ ...base, match: "always" }).success).toBe(false)
	})
})
