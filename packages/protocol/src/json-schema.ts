import { zodToJsonSchema } from "zod-to-json-schema"
import { ActionResultSchema, type ModuleActionParam, paramsToZod } from "./schemas"

/** A JSON Schema (draft-07) document. */
export type JsonSchema = Record<string, unknown>

function toJsonSchema(schema: Parameters<typeof zodToJsonSchema>[0]): JsonSchema {
	// `$refStrategy: "none"` inlines everything so each schema stands alone.
	return zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as JsonSchema
}

/**
 * The JSON Schema of an action's params, generated from the same Zod schema
 * `runAction` validates against: an object with `additionalProperties: false`,
 * `required` listing the required params, and each param's description,
 * enum values, element type, nested properties, and default.
 */
export function paramsJsonSchema(params: readonly ModuleActionParam[]): JsonSchema {
	return toJsonSchema(paramsToZod(params))
}

/** The JSON Schema of the `ActionResult` receipt that `runAction` returns. */
export function actionResultJsonSchema(): JsonSchema {
	return toJsonSchema(ActionResultSchema)
}
