import { AgentRole, OrchestrationState, StepResponse, WorkflowStep } from "@repo/protocol"

// Importing PI Engine API types (mocked or required at runtime via Extension API)
// In a production context, this would rely on the PI Extension API injected at runtime
interface PIProvider {
	invoke: (prompt: string, schema: any) => Promise<any>
}

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

// Generic Orchestrator Step
export const orchestratePlanningStep: WorkflowStep<PlanningInput, PlanningOutput, null> = {
	name: "orchestrate-planning-step",
	role: AgentRole.ORCHESTRATOR,

	execute: async (input, state): Promise<StepResponse<PlanningOutput, null>> => {
		try {
			// In production, we get access to the PI Extension API instance
			const pi = (global as any).pi as PIProvider
			if (!pi) throw new Error("PI Provider not initialized")

			// 1. Construct prompt
			const prompt = `
Task: Decompose intent into deterministic module actions.
Intent: ${input.intent}
Available Modules: ${input.availableModules.join(", ")}
Rules: 
- Respond strictly in the required JSON schema format.
- Use only available modules and actions.
`

			// 2. Execute via PI provider with schema validation
			// This delegates raw LLM interaction to the configured PI provider
			const response = await pi.invoke(prompt, {
				type: "object",
				properties: {
					resolvedSteps: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								module: { type: "string" },
								action: { type: "string" },
								params: { type: "object" },
							},
							required: ["id", "module", "action", "params"],
						},
					},
				},
				required: ["resolvedSteps"],
			})

			// 3. Parse and return
			return {
				success: true,
				output: { resolvedSteps: response.resolvedSteps },
				compensationData: null,
			}
		} catch (err: any) {
			return {
				success: false,
				output: { resolvedSteps: [] },
				compensationData: null,
				error: err.message || "Orchestration execution failure.",
			}
		}
	},

	compensate: async (_data, _state): Promise<void> => {
		return Promise.resolve()
	},
}

