import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepResponse, WorkflowStep } from "baka-sdk"
import { AgentRole } from "baka-sdk"

export interface InitConstitutionInput {
	productName: string
	summary: string
	tone?: string
	renderedTemplates?: Record<string, string>
}

export interface InitConstitutionCompensationData {
	targetDirectory: string
	createdFiles: string[]
}

const step: WorkflowStep<InitConstitutionInput, boolean, InitConstitutionCompensationData> = {
	name: "sdd.init-constitution",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, InitConstitutionCompensationData>> => {
		const target = state.targetDirectory
		const renderedTemplates = input.renderedTemplates ?? {}

		if (!target) {
			return error(target, [], "targetDirectory is required")
		}
		if (!input.productName) {
			return error(target, [], "input.productName is required")
		}
		if (!input.summary) {
			return error(target, [], "input.summary is required")
		}

		const created: string[] = []
		const writeIfAbsent = (rel: string, content: string) => {
			const full = join(target, rel)
			if (existsSync(full)) return
			mkdirSync(join(full, ".."), { recursive: true })
			writeFileSync(full, content, "utf-8")
			created.push(full)
		}

		// RenderedTemplates keys come from worker.ts and use the kebab-case
		// filename stem (e.g. "mission.md", "tech-stack.md", "roadmap.md").
		// Fall back to a short stub if the LLM did not produce content for a key.
		const fallback = (heading: string, body: string) => `# ${heading}\n\n${body}\n`

		writeIfAbsent(
			join("specs", "mission.md"),
			renderedTemplates["mission.md"] ?? fallback(`${input.productName} — Mission`, input.summary),
		)
		writeIfAbsent(
			join("specs", "tech-stack.md"),
			renderedTemplates["tech-stack.md"] ?? fallback(`${input.productName} — Tech Stack`, "(not yet decided)"),
		)
		writeIfAbsent(
			join("specs", "roadmap.md"),
			renderedTemplates["roadmap.md"] ?? fallback(`${input.productName} — Roadmap`, "## Phase 1\n- TBD"),
		)

		return {
			success: true,
			output: true,
			compensationData: { targetDirectory: target, createdFiles: created },
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
	},
}

function error(
	target: string,
	created: string[],
	message: string,
): StepResponse<boolean, InitConstitutionCompensationData> {
	return {
		success: false,
		output: false,
		compensationData: { targetDirectory: target, createdFiles: created },
		error: message,
	}
}

export default step
