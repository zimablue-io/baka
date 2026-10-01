import { describe, expect, it } from "vitest"
import {
	assertHandlebarsSubset,
	canonicalJson,
	formatSlotValue,
	hashBytes,
	interpolatePath,
	parseSlots,
	renderTemplate,
	SlotTemplateError,
	slotCacheKey,
} from "./slots.js"

describe("parseSlots", () => {
	it("extracts a named prose slot with max and hint", () => {
		const src = `# {{projectName}}\n{{#slot "introduction" kind="prose" max=120}}\n2-3 sentences.\n{{/slot}}\n`
		const slots = parseSlots(src, "README.md.hbs")
		expect(slots).toEqual([
			{
				id: "introduction",
				kind: "prose",
				hint: "2-3 sentences.",
				file: "README.md.hbs",
				max: 120,
				item: undefined,
				schemaPath: undefined,
			},
		])
	})

	it("rejects duplicate slot ids", () => {
		const src = `{{#slot "a" kind="prose"}}x{{/slot}}{{#slot "a" kind="ident"}}y{{/slot}}`
		expect(() => parseSlots(src, "dup.hbs")).toThrow(SlotTemplateError)
	})

	it("rejects unknown kinds", () => {
		const src = `{{#slot "a" kind="essay"}}x{{/slot}}`
		expect(() => parseSlots(src, "bad.hbs")).toThrow(/unknown kind/)
	})
})

describe("assertHandlebarsSubset", () => {
	it("allows params, if, each, and slots", () => {
		const src = `{{#if ok}}{{name}}{{/if}}{{#each items}}{{this}}{{/each}}{{#slot "s" kind="prose"}}h{{/slot}}`
		expect(() => assertHandlebarsSubset(src)).not.toThrow()
	})

	it("rejects custom helpers", () => {
		expect(() => assertHandlebarsSubset("{{uppercase name}}")).toThrow(/custom helper/)
	})

	it("rejects triple-stash", () => {
		expect(() => assertHandlebarsSubset("{{{raw}}}")).toThrow(/triple-stash/)
	})
})

describe("renderTemplate", () => {
	it("interpolates params and concatenates slot fills; the model never authors headings", () => {
		const src = `# {{projectName}}\n{{#slot "introduction" kind="prose" max=80}}hint{{/slot}}\n`
		const out = renderTemplate(src, { projectName: "Widget" }, { introduction: "A tiny CLI." })
		expect(out).toBe("# Widget\nA tiny CLI.\n")
	})

	it("renders list slots as markdown bullets", () => {
		const src = `{{#slot "features" kind="list"}}{{/slot}}`
		const out = renderTemplate(src, {}, { features: ["fast", "small"] })
		expect(out).toBe("- fast\n- small")
	})
})

describe("interpolatePath", () => {
	it("fills params in output paths", () => {
		expect(interpolatePath("specs/{{name}}/plan.md", { name: "auth" })).toBe("specs/auth/plan.md")
	})
})

describe("slotCacheKey", () => {
	it("is stable for the same templateHash + slotId + paramsHash + model", () => {
		const a = slotCacheKey({
			templateHash: hashBytes("t"),
			slotId: "introduction",
			paramsHash: hashBytes(canonicalJson({ n: 1 })),
			model: "gemma4:e4b",
		})
		const b = slotCacheKey({
			templateHash: hashBytes("t"),
			slotId: "introduction",
			paramsHash: hashBytes(canonicalJson({ n: 1 })),
			model: "gemma4:e4b",
		})
		expect(a).toBe(b)
		expect(a).toHaveLength(64)
	})

	it("changes when the model changes", () => {
		const base = {
			templateHash: hashBytes("t"),
			slotId: "introduction",
			paramsHash: hashBytes("{}"),
		}
		expect(slotCacheKey({ ...base, model: "gemma4:e4b" })).not.toBe(slotCacheKey({ ...base, model: "other" }))
	})
})

describe("formatSlotValue", () => {
	it("stringifies json fills", () => {
		expect(formatSlotValue({ id: "c", kind: "json", hint: "", file: "x" }, { a: 1 })).toContain('"a"')
	})
})
