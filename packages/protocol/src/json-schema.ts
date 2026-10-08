import { z } from "zod"
import { ActionResultSchema, type ModuleActionParam, type ParamTypeNode, paramsToZod } from "./schemas"

/** A JSON Schema (draft-07) document. */
export type JsonSchema = Record<string, unknown>

function toJsonSchema(schema: z.ZodType): JsonSchema {
	// `reused: "inline"` inlines everything so each schema stands alone, and `io: "input"` describes what a caller has
	// to send: a param with a default is optional in the input even though the run always has a value for it.
	return z.toJSONSchema(schema, { target: "draft-07", reused: "inline", io: "input" }) as JsonSchema
}

/**
 * The JSON Schema of an action's params, generated from the same Zod schema
 * `runAction` validates against: an object with `additionalProperties: false`,
 * `required` listing the required params, and each param's description,
 * enum values, element type, nested properties, and default.
 */
export function paramsJsonSchema(params: readonly ModuleActionParam[]): JsonSchema {
	const schema = toJsonSchema(paramsToZod(params))
	annotateObject(schema, params)
	return schema
}

/**
 * `pattern`, `minLength`, and `maxLength` are standard keywords and come from
 * the Zod schema. A named `format` is carried as its expanded `pattern` and
 * also as `x-baka-format`, so a reader can tell `slug` from a hand-written
 * regex without a draft-07 validator rejecting an unknown `format` name.
 */
function annotateObject(schema: JsonSchema, params: readonly ModuleActionParam[]): void {
	const properties = schema.properties as Record<string, JsonSchema> | undefined
	if (!properties) return
	for (const param of params) {
		const property = properties[param.name]
		if (property) annotateNode(property, param)
	}
}

function annotateNode(schema: JsonSchema, node: ParamTypeNode): void {
	if (node.format) schema["x-baka-format"] = node.format
	if (node.type === "array" && node.items && schema.items) annotateNode(schema.items as JsonSchema, node.items)
	if (node.type === "object" && node.properties) annotateObject(schema, node.properties)
}

/** The JSON Schema of the `ActionResult` receipt that `runAction` returns. */
export function actionResultJsonSchema(): JsonSchema {
	return toJsonSchema(ActionResultSchema)
}
