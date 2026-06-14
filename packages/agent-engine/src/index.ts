import { OrchestrationState, StepResponse, WorkflowStep } from "@repo/protocol"

interface PlanningInput {
	intent: string
	availableModules: string[]
}

interface PlanningOutput {
	resolvedSteps: Array<{
		id: string
		module: string
		action: string
		params: Record<string, any>
	}>
}

export const runGemmaPlanningStep: WorkflowStep<PlanningInput, PlanningOutput, null> = {
	name: "run-gemma-planning-step",

	execute: async (input, state): Promise<StepResponse<PlanningOutput, null>> => {
		try {
			// In a real system call, this transmits a compacted, grammar-bound schema mapping directly to Gemma 4 via IPC/Stdio
			// We are mocking the execution channel using programmatic analysis matching the strict structure.

			const matchedSteps: PlanningOutput["resolvedSteps"] = []

			if (input.intent.toLowerCase().includes("auth")) {
				matchedSteps.push({
					id: "step_1_init_base",
					module: "next-base",
					action: "init",
					params: {},
				})
				matchedSteps.push({
					id: "step_2_inject_auth",
					module: "auth",
					action: "init_better_auth",
					params: { providers: "github,google" },
				})
			} else {
				matchedSteps.push({
					id: "step_1_init_base",
					module: "next-base",
					action: "init",
					params: {},
				})
			}

			return {
				success: true,
				output: { resolvedSteps: matchedSteps },
				compensationData: null,
			}
		} catch (err: any) {
			return {
				success: false,
				output: { resolvedSteps: [] },
				compensationData: null,
				error: err.message || "Gemma processing frame execution failure.",
			}
		}
	},

	compensate: async (_data, _state): Promise<void> => {
		// Planning operations do not mutate external files and carry no modification state side effects.
		return Promise.resolve()
	},
}
