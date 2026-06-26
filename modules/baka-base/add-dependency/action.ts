import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepResponse, WorkflowStep } from "baka-sdk"
import { AgentRole } from "baka-sdk"
import { readJsonSafe } from "../_shared/helpers/read-json-safe"

export interface AddDependencyInput {
	name: string
	version: string
	dev?: boolean
}

export interface AddDependencyCompensationData {
	targetDirectory: string
	packageJsonPath: string
	previousContent: string
	dependencyName: string
	wasDev: boolean
}

export const addDependencyAction: WorkflowStep<AddDependencyInput, boolean, AddDependencyCompensationData> = {
	name: "baka-base.add-dependency",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, AddDependencyCompensationData>> => {
		const target = state.targetDirectory
		const packageJsonPath = join(target, "package.json")
		if (!existsSync(packageJsonPath)) {
			return {
				success: false,
				output: false,
				compensationData: {
					targetDirectory: target,
					packageJsonPath,
					previousContent: "",
					dependencyName: input.name,
					wasDev: input.dev ?? false,
				},
				error: "package.json not found; run baka-base.scaffold first",
			}
		}

		const previousContent = readFileSync(packageJsonPath, "utf-8")
		const parsed = readJsonSafe<Record<string, unknown>>(packageJsonPath)
		if (!parsed) {
			return {
				success: false,
				output: false,
				compensationData: {
					targetDirectory: target,
					packageJsonPath,
					previousContent,
					dependencyName: input.name,
					wasDev: input.dev ?? false,
				},
				error: `package.json is not valid JSON or is missing`,
			}
		}

		const bucket = input.dev ? "devDependencies" : "dependencies"
		const existing = (parsed[bucket] as Record<string, string> | undefined) ?? {}
		parsed[bucket] = { ...existing, [input.name]: input.version }

		try {
			writeFileSync(packageJsonPath, `${JSON.stringify(parsed, null, "\t")}\n`, "utf-8")
		} catch (err) {
			return {
				success: false,
				output: false,
				compensationData: {
					targetDirectory: target,
					packageJsonPath,
					previousContent,
					dependencyName: input.name,
					wasDev: input.dev ?? false,
				},
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
				dependencyName: input.name,
				wasDev: input.dev ?? false,
			},
		}
	},

	compensate: async (data, _state): Promise<void> => {
		try {
			const { writeFileSync } = require("node:fs") as typeof import("node:fs")
			writeFileSync(data.packageJsonPath, data.previousContent, "utf-8")
		} catch {
			/* best effort */
		}
	},
}
