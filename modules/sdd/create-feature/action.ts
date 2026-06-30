import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepResponse, WorkflowStep } from "baka-sdk"
import { AgentRole } from "baka-sdk"

export interface CreateFeatureInput {
	name: string
	description: string
	context?: string
	renderedTemplates?: Record<string, string>
}

export interface CreateFeatureCompensationData {
	targetDirectory: string
	createdFiles: string[]
	featureFolder: string
}

const step: WorkflowStep<CreateFeatureInput, boolean, CreateFeatureCompensationData> = {
	name: "sdd.create-feature",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, CreateFeatureCompensationData>> => {
		const target = state.targetDirectory
		const featureName = input.name
		const renderedTemplates = input.renderedTemplates ?? {}

		if (!target) {
			return error(target, "", [], "targetDirectory is required")
		}
		if (!featureName) {
			return error(target, "", [], "input.name (feature name) is required")
		}
		if (!input.description) {
			return error(target, "", [], "input.description is required")
		}
		if (!/^[a-z0-9-_]+$/.test(featureName)) {
			return error(target, "", [], `feature name must be kebab-case: ${featureName}`)
		}

		// specs/YYYY-MM-DD-<name>/ — date prefix from today's local date so
		// features are chronologically orderable in the filesystem.
		const today = new Date().toISOString().slice(0, 10)
		const folder = `${today}-${featureName}`
		const featureDir = join(target, "specs", folder)

		const created: string[] = []
		const writeIfAbsent = (rel: string, content: string) => {
			const full = join(target, rel)
			mkdirSync(join(full, ".."), { recursive: true })
			if (existsSync(full)) return
			writeFileSync(full, content, "utf-8")
			created.push(full)
		}

		const fallback = (heading: string) => `# ${heading}\n\n_TBD_\n`

		writeIfAbsent(join("specs", folder, "plan.md"), renderedTemplates["plan.md"] ?? fallback(`${featureName} — Plan`))
		writeIfAbsent(
			join("specs", folder, "requirements.md"),
			renderedTemplates["requirements.md"] ?? fallback(`${featureName} — Requirements`),
		)
		writeIfAbsent(
			join("specs", folder, "validation.md"),
			renderedTemplates["validation.md"] ?? fallback(`${featureName} — Validation`),
		)

		return {
			success: true,
			output: true,
			compensationData: { targetDirectory: target, createdFiles: created, featureFolder: featureDir },
		}
	},

	compensate: async (data) => {
		const { rmSync } = await import("node:fs")
		for (const file of data.createdFiles) {
			try {
				rmSync(file, { force: true })
			} catch {
				/* best effort */
			}
		}
		try {
			rmSync(data.featureFolder, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	},
}

function error(
	target: string,
	folder: string,
	created: string[],
	message: string,
): StepResponse<boolean, CreateFeatureCompensationData> {
	return {
		success: false,
		output: false,
		compensationData: { targetDirectory: target, createdFiles: created, featureFolder: folder },
		error: message,
	}
}

export default step
