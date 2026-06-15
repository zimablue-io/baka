import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepResponse, WorkflowStep, OrchestrationState } from "baka-sdk"
import { AgentRole } from "baka-sdk"
import { readJsonSafe } from "../_shared/helpers/readJsonSafe"

export interface AddScriptInput {
	name: string
	command: string
}

export interface AddScriptCompensationData {
	targetDirectory: string
	packageJsonPath: string
	previousContent: string
	// True if this call created the script; false if it updated an existing one.
	created: boolean
	scriptName: string
	previousCommand: string | null
}

export const addScriptAction: WorkflowStep<AddScriptInput, boolean, AddScriptCompensationData> = {
	name: "baka-base.add-script",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, AddScriptCompensationData>> => {
		const target = state.targetDirectory
		const packageJsonPath = join(target, "package.json")
		if (!existsSync(packageJsonPath)) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, packageJsonPath, previousContent: "", created: false, scriptName: input.name, previousCommand: null },
				error: "package.json not found; run baka-base.scaffold first",
			}
		}

		const previousContent = readFileSync(packageJsonPath, "utf-8")
		const parsed = readJsonSafe<Record<string, unknown>>(packageJsonPath)
		if (!parsed) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, packageJsonPath, previousContent, created: false, scriptName: input.name, previousCommand: null },
				error: `package.json is not valid JSON or is missing`,
			}
		}

		const scripts = (parsed.scripts as Record<string, string> | undefined) ?? {}
		const previousCommand = scripts[input.name] ?? null
		parsed.scripts = { ...scripts, [input.name]: input.command }

		try {
			writeFileSync(packageJsonPath, JSON.stringify(parsed, null, "\t") + "\n", "utf-8")
		} catch (err) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, packageJsonPath, previousContent, created: previousCommand === null, scriptName: input.name, previousCommand },
				error: err instanceof Error ? err.message : String(err),
			}
		}

		return {
			success: true,
			output: true,
			compensationData: {
				targetDirectory: target,
				packageJsonPath,
				previousContent,
				created: previousCommand === null,
				scriptName: input.name,
				previousCommand,
			},
		}
	},

	compensate: async (data, _state): Promise<void> => {
		// Restore the previous file content. This is the safest rollback for
		// any edit to a JSON file: we never re-parse and re-serialize, so we
		// don't risk dropping whitespace, comments, or unrelated edits.
		try {
			const { writeFileSync } = require("node:fs") as typeof import("node:fs")
			writeFileSync(data.packageJsonPath, data.previousContent, "utf-8")
		} catch {
			/* best effort */
		}
	},
}
