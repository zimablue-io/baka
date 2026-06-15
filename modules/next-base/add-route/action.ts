import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, sep } from "node:path"
import type { StepResponse, WorkflowStep, OrchestrationState } from "baka-sdk"
import { AgentRole } from "baka-sdk"

export interface AddRouteInput {
	path: string
}

export interface AddRouteCompensationData {
	targetDirectory: string
	createdFile: string
}

export const addRouteAction: WorkflowStep<AddRouteInput, boolean, AddRouteCompensationData> = {
	name: "next-base.add-route",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, AddRouteCompensationData>> => {
		const target = state.targetDirectory
		const segments = input.path
			.split("/")
			.map((s) => s.trim())
			.filter(Boolean)
		if (segments.length === 0) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, createdFile: "" },
				error: "path must not be empty",
			}
		}
		for (const seg of segments) {
			if (!/^[a-z0-9-_]+$/.test(seg)) {
				return {
					success: false,
					output: false,
					compensationData: { targetDirectory: target, createdFile: "" },
					error: `segment "${seg}" must be lowercase letters, digits, _ or -`,
				}
			}
		}
		// Prefer src/app; fall back to app/ at the root.
		const baseApp = existsSync(join(target, "src", "app")) ? join("src", "app") : "app"
		const rel = join(baseApp, ...segments, "page.tsx")
		const full = join(target, rel)
		if (existsSync(full)) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, createdFile: "" },
				error: `${rel} already exists`,
			}
		}
		try {
			mkdirSync(join(full, ".."), { recursive: true })
			writeFileSync(full, renderPage(segments.join("/")), "utf-8")
			return {
				success: true,
				output: true,
				compensationData: { targetDirectory: target, createdFile: full },
			}
		} catch (err) {
			return {
				success: false,
				output: false,
				compensationData: { targetDirectory: target, createdFile: "" },
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},

	compensate: async (data, _state): Promise<void> => {
		if (!data.createdFile) return
		const { rmSync } = require("node:fs") as typeof import("node:fs")
		try {
			rmSync(data.createdFile, { force: true })
		} catch {
			/* best effort */
		}
	},
}

function renderPage(segment: string): string {
	const component = segment
		.split("/")
		.map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase()))
		.join("")
	return `export default function ${component}Page() {
	return (
		<main>
			<h1>${segment}</h1>
		</main>
	)
}
`
}
