import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AgentRole, type StepResponse, type WorkflowStep } from "baka-sdk"

export const writeAction: WorkflowStep<Record<string, never>, boolean, { targetDirectory: string }> = {
	name: "honest-mod.write",
	role: AgentRole.WORKER,

	execute: async (_input, state): Promise<StepResponse<boolean, { targetDirectory: string }>> => {
		const targetDirectory = state.targetDirectory
		writeFileSync(join(targetDirectory, "marker.txt"), "honest-mod was here\n", "utf-8")
		return {
			success: true,
			output: true,
			compensationData: { targetDirectory },
		}
	},

	compensate: async (data): Promise<void> => {
		try {
			rmSync(join(data.targetDirectory, "marker.txt"), { force: true })
		} catch {
			// best effort
		}
	},
}
