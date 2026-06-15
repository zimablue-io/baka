import type { DesignedAction } from "../state"

// ---------------------------------------------------------------------------
// Code-stub renderers. Each one takes the designed state and returns the
// source text of a TypeScript / Handlebars file. Pure functions, no I/O.
// writeModuleFiles (in ./write.ts) calls these and writes the result.
// ---------------------------------------------------------------------------

export function renderManifestSource(args: {
	moduleName: string
	description: string
	deps: string[]
	actions: Array<{
		id: string
		description: string
		params: DesignedAction["params"]
		requiresReasoning: boolean
		compensatesWith: string | null
		validators: DesignedAction["validators"]
	}>
}): string {
	const manifest = {
		name: args.moduleName,
		version: "0.1.0",
		description: args.description || "Auto-generated module.",
		dependencies: args.deps,
		conflictsWith: [],
		actions: args.actions.map((a) => ({
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
		moduleValidators: [],
	}
	return `import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = ${JSON.stringify(manifest, null, "\t")}
`
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1)
}

function tsType(p: DesignedAction["params"][number]): string {
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

export function renderActionStubSource(action: {
	id: string
	description: string
	params: DesignedAction["params"]
	requiresReasoning: boolean
	compensatesWith: string | null
}): string {
	const cap = capitalize(action.id)
	const inputType = `${cap}Input`
	const compType = `${cap}CompensationData`
	const paramFields = action.params.map((p) => `\t${p.name}${p.required ? "" : "?"}: ${tsType(p)}`).join("\n")
	return `import type { ActionFn, CompensationFn } from "baka-sdk"

/**
 * ${action.description}
 */
export interface ${inputType} {
${paramFields || "\t// no params"}
}

export interface ${compType} {
\ttargetDirectory: string
\tactionData: ${inputType}
\tcreatedFiles: string[]
}

export const ${action.id}: ActionFn<${inputType}, ${compType}> = async (input, state) => {
\t// TODO: implement the action body. Use the params from \`input\`, write into
\t// \`state.targetDirectory\`, and return a list of files you created so the
\t// validators can inspect them.
\treturn {
\t\tcompensationData: {
\t\t\ttargetDirectory: state.targetDirectory,
\t\t\tactionData: input,
\t\t\tcreatedFiles: [],
\t\t},
\t}
}

export const compensate: CompensationFn<${compType}> = async (data) => {
\t// TODO: undo what the action did. Delete files in data.createdFiles.
\tvoid data
}
`
}

export function renderValidatorStubSource(validatorId: string, purpose: string): string {
	return `import type { ActionValidatorFn } from "baka-sdk"

/**
 * ${purpose}
 */
export const validator: ActionValidatorFn = async (_state, _actionData) => {
\t// TODO: inspect _state.targetDirectory and the files the action produced
\t// (in _actionData.compensationData.createdFiles). Return one diagnostic
\t// per finding. Return [] to pass.
\treturn []
}
`
}

export function renderTemplateStubSource(actionId: string, templateId: string, outline: string): string {
	return `{{!--
  Action: ${actionId}
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
