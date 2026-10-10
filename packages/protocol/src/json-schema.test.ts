import { describe, expect, it } from "vitest"
import { paramsJsonSchema, recipeResultJsonSchema } from "./json-schema"
import { type PackRecipeParam, PackRecipeParamSchema } from "./schemas"

const PARAMS: PackRecipeParam[] = [
	{ name: "name", type: "string", required: true, description: "Project name." },
	{ name: "strict", type: "boolean", required: false, description: "Strict mode.", default: true },
	{ name: "retries", type: "number", required: false, description: "Retry count." },
	{ name: "tone", type: "enum", required: true, description: "Voice.", enumValues: ["plain", "formal"] },
	{
		name: "tags",
		type: "array",
		required: false,
		description: "Labels.",
		items: { type: "string", description: "One label." },
	},
	{
		name: "owner",
		type: "object",
		required: false,
		description: "Who owns it.",
		properties: [
			{ name: "login", type: "string", required: true, description: "Handle." },
			{ name: "admin", type: "boolean", required: false, description: "Is admin.", default: false },
		],
	},
]

describe("paramsJsonSchema", () => {
	const schema = paramsJsonSchema(PARAMS) as {
		type: string
		additionalProperties: boolean
		required: string[]
		properties: Record<string, Record<string, unknown>>
		$schema: string
	}

	it("is a closed draft-07 object listing the required params", () => {
		expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#")
		expect(schema.type).toBe("object")
		expect(schema.additionalProperties).toBe(false)
		expect([...schema.required].sort()).toEqual(["name", "tone"])
		expect(Object.keys(schema.properties)).toEqual(["name", "strict", "retries", "tone", "tags", "owner"])
	})

	it("carries types, descriptions, enum values, and defaults", () => {
		expect(schema.properties.name).toEqual({ type: "string", description: "Project name." })
		expect(schema.properties.strict).toEqual({ type: "boolean", description: "Strict mode.", default: true })
		expect(schema.properties.retries).toEqual({ type: "number", description: "Retry count." })
		expect(schema.properties.tone).toEqual({ type: "string", enum: ["plain", "formal"], description: "Voice." })
	})

	it("describes arrays by their element type and objects by their fields", () => {
		expect(schema.properties.tags).toEqual({
			type: "array",
			items: { type: "string", description: "One label." },
			description: "Labels.",
		})
		expect(schema.properties.owner).toMatchObject({
			type: "object",
			description: "Who owns it.",
			additionalProperties: false,
			required: ["login"],
			properties: {
				login: { type: "string", description: "Handle." },
				admin: { type: "boolean", description: "Is admin.", default: false },
			},
		})
	})

	it("is a plain JSON document: it survives a JSON round trip unchanged", () => {
		expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
	})

	it("describes a param-less recipe as an empty closed object", () => {
		expect(paramsJsonSchema([])).toMatchObject({ type: "object", properties: {}, additionalProperties: false })
	})
})

describe("recipeResultJsonSchema", () => {
	it("describes the receipt a run returns", () => {
		const schema = recipeResultJsonSchema() as {
			required: string[]
			properties: Record<string, { type?: string; enum?: string[]; items?: { properties?: Record<string, unknown> } }>
		}
		expect(schema.required).toEqual(
			expect.arrayContaining([
				"ok",
				"pack",
				"recipe",
				"diagnostics",
				"changeset",
				"outputTreeHash",
				"slots",
				"compensation",
				"dryRun",
			]),
		)
		expect(schema.properties.ok?.type).toBe("boolean")
		expect(schema.properties.changeset?.items?.properties).toHaveProperty("contentHash")
		expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
	})
})

describe("PackRecipeParamSchema, extended types", () => {
	const base = { name: "p", required: false, description: "d" }

	it("accepts array and object params, nested", () => {
		expect(
			PackRecipeParamSchema.safeParse({
				...base,
				type: "array",
				items: { type: "object", properties: [{ name: "id", type: "number", required: true, description: "id" }] },
			}).success,
		).toBe(true)
	})

	it.each([
		["an enum without values", { ...base, type: "enum" }],
		["an array without items", { ...base, type: "array" }],
		["an object without properties", { ...base, type: "object" }],
		["enumValues on a string", { ...base, type: "string", enumValues: ["a"] }],
		["a default of the wrong type", { ...base, type: "number", default: "three" }],
		["a default outside the enum", { ...base, type: "enum", enumValues: ["a"], default: "b" }],
		["a required param with a default", { ...base, type: "string", required: true, default: "x" }],
		["a nested param that is itself invalid", { ...base, type: "array", items: { type: "enum" } }],
	])("rejects %s", (_label, param) => {
		expect(PackRecipeParamSchema.safeParse(param).success).toBe(false)
	})
})

describe("paramsJsonSchema string constraints", () => {
	const schema = paramsJsonSchema([
		{ name: "a", type: "string", required: true, description: "a", pattern: "^x", minLength: 2, maxLength: 5 },
		{ name: "b", type: "string", required: true, description: "b", format: "slug" },
		{ name: "c", type: "array", required: false, description: "c", items: { type: "string", format: "path-segment" } },
	]) as { properties: Record<string, Record<string, unknown>> }

	it("exports pattern, minLength, and maxLength as the standard keywords", () => {
		expect(schema.properties.a).toMatchObject({ type: "string", pattern: "^x", minLength: 2, maxLength: 5 })
	})

	it("exports a named format as its pattern plus x-baka-format, and does so for array items", () => {
		expect(schema.properties.b).toMatchObject({ type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })
		expect(schema.properties.b?.["x-baka-format"]).toBe("slug")
		const items = schema.properties.c?.items as Record<string, unknown>
		expect(items["x-baka-format"]).toBe("path-segment")
		expect(typeof items.pattern).toBe("string")
	})

	it("the exported patterns accept and reject what the engine does", () => {
		const slug = new RegExp(schema.properties.b?.pattern as string)
		expect(slug.test("my-app")).toBe(true)
		expect(slug.test("../x")).toBe(false)
	})
})
