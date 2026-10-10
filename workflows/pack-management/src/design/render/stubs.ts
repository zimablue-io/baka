import type { DesignedRecipe } from "../state"

// ---------------------------------------------------------------------------
// Code-stub renderers. Each one takes the designed state and returns the
// source text of a TypeScript / Handlebars file. Pure functions, no I/O.
// writePackFiles (in ./write.ts) calls these and writes the result.
// ---------------------------------------------------------------------------

export function renderManifestSource(args: {
	packName: string
	description: string
	deps: string[]
	recipes: Array<{
		id: string
		description: string
		params: DesignedRecipe["params"]
		requiresReasoning: boolean
		compensatesWith: string | null
		validators: DesignedRecipe["validators"]
	}>
}): string {
	const manifest = {
		name: args.packName,
		version: "0.1.0",
		description: args.description || "Auto-generated pack.",
		dependencies: args.deps,
		conflictsWith: [],
		recipes: args.recipes.map((a) => ({
			id: a.id,
			description: a.description,
			params: a.params.map((p) => ({
				name: p.name,
				type: p.type,
				required: p.required,
				description: p.description,
				...(p.enumValues ? { enumValues: p.enumValues } : {}),
			})),
			requiresReasoning: a.requiresReasoning,
			...(a.compensatesWith ? { compensatesWith: a.compensatesWith } : {}),
			validators: a.validators.map((v) => v.id),
		})),
		packValidators: [],
	}
	return `import type { PackManifest } from "baka-sdk"

export const Manifest: PackManifest = ${JSON.stringify(manifest, null, "\t")}
`
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1)
}

function tsType(p: DesignedRecipe["params"][number]): string {
	switch (p.type) {
		case "string":
			return "string"
		case "boolean":
			return "boolean"
		case "number":
			return "number"
		case "enum":
			return p.enumValues && p.enumValues.length > 0 ? p.enumValues.map((v) => `"${v}"`).join(" | ") : "string"
		default:
			return "unknown"
	}
}

export function renderRecipeStubSource(recipe: {
	id: string
	description: string
	params: DesignedRecipe["params"]
	requiresReasoning: boolean
	compensatesWith: string | null
}): string {
	const cap = capitalize(recipe.id)
	const inputType = `${cap}Input`
	const compType = `${cap}CompensationData`
	const paramFields = recipe.params.map((p) => `\t${p.name}${p.required ? "" : "?"}: ${tsType(p)}`).join("\n")
	return `import type { RecipeFn, CompensationFn } from "baka-sdk"

/**
 * ${recipe.description}
 */
export interface ${inputType} {
${paramFields || "\t// no params"}
}

export interface ${compType} {
\ttargetDirectory: string
\trecipeData: ${inputType}
\tcreatedFiles: string[]
}

export const ${recipe.id}: RecipeFn<${inputType}, ${compType}> = async (input, state) => {
\t// TODO: implement the recipe body. Use the params from \`input\`, write into
\t// \`state.targetDirectory\`, and return a list of files you created so the
\t// validators can inspect them.
\treturn {
\t\tcompensationData: {
\t\t\ttargetDirectory: state.targetDirectory,
\t\t\trecipeData: input,
\t\t\tcreatedFiles: [],
\t\t},
\t}
}

export const compensate: CompensationFn<${compType}> = async (data) => {
\t// TODO: undo what the recipe did. Delete files in data.createdFiles.
\tvoid data
}
`
}

export function renderValidatorStubSource(_validatorId: string, purpose: string): string {
	return `import type { RecipeValidatorFn } from "baka-sdk"

/**
 * ${purpose}
 */
export const validator: RecipeValidatorFn = async (_state, _recipeData) => {
\t// TODO: inspect _state.targetDirectory and the files the recipe produced
\t// (in _recipeData.compensationData.createdFiles). Return one diagnostic
\t// per finding. Return [] to pass.
\treturn []
}
`
}

export function renderTemplateStubSource(recipeId: string, templateId: string, outline: string): string {
	return `{{!--
  Recipe: ${recipeId}
  Template: ${templateId}
  Outline (filled by the Worker at run time via the LLM):
${outline
	.split("\n")
	.map((l) => `  ${l}`)
	.join("\n")}
--}}
{{{body}}}
`
}
