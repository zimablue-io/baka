import { describe, expect, it } from "vitest"
import { actionResultJsonSchema, paramsJsonSchema } from "./json-schema"
import { type ModuleActionParam, ModuleActionParamSchema } from "./schemas"

const PARAMS: ModuleActionParam[] = [
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

	it("describes a param-less action as an empty closed object", () => {
		expect(paramsJsonSchema([])).toMatchObject({ type: "object", properties: {}, additionalProperties: false })
	})
})

describe("actionResultJsonSchema", () => {
	it("describes the receipt a run returns", () => {
		const schema = actionResultJsonSchema() as {
			required: string[]
			properties: Record<string, { type?: string; enum?: string[]; items?: { properties?: Record<string, unknown> } }>
		}
		expect(schema.required).toEqual(
			expect.arrayContaining([
				"ok",
				"module",
				"action",
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

describe("ModuleActionParamSchema, extended types", () => {
	const base = { name: "p", required: false, description: "d" }

	it("accepts array and object params, nested", () => {
		expect(
			ModuleActionParamSchema.safeParse({
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
		expect(ModuleActionParamSchema.safeParse(param).success).toBe(false)
	})
})
