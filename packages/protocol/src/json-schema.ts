import { zodToJsonSchema } from "zod-to-json-schema"
import { type PackRecipeParam, type ParamTypeNode, paramsToZod, RecipeResultSchema } from "./schemas"

/** A JSON Schema (draft-07) document. */
export type JsonSchema = Record<string, unknown>

function toJsonSchema(schema: Parameters<typeof zodToJsonSchema>[0]): JsonSchema {
	// `$refStrategy: "none"` inlines everything so each schema stands alone.
	return zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as JsonSchema
}

/**
 * The JSON Schema of a recipe's params, generated from the same Zod schema
 * `runRecipe` validates against: an object with `additionalProperties: false`,
 * `required` listing the required params, and each param's description,
 * enum values, element type, nested properties, and default.
 */
export function paramsJsonSchema(params: readonly PackRecipeParam[]): JsonSchema {
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
function annotateObject(schema: JsonSchema, params: readonly PackRecipeParam[]): void {
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

/** The JSON Schema of the `RecipeResult` receipt that `runRecipe` returns. */
export function recipeResultJsonSchema(): JsonSchema {
	return toJsonSchema(RecipeResultSchema)
}
