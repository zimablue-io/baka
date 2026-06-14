import { z } from "zod"
import { ModuleActionParamSchema, ModuleActionSchema, ModuleManifestSchema, OrchestrationStateSchema } from "./schemas"

export type ModuleActionParam = z.infer<typeof ModuleActionParamSchema>
export type ModuleAction = z.infer<typeof ModuleActionSchema>
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>
export type OrchestrationState = z.infer<typeof OrchestrationStateSchema>

export enum AgentRole {
	ORCHESTRATOR = "orchestrator",
	WORKER = "worker",
	VALIDATOR = "validator",
}

export interface StepResponse<TOutput, TCompensationData> {
	success: boolean
	output: TOutput
	compensationData: TCompensationData
	error?: string
}

export interface WorkflowStep<TInput, TOutput, TCompensationData> {
	name: string
	role: AgentRole
	execute: (input: TInput, state: OrchestrationState) => Promise<StepResponse<TOutput, TCompensationData>>
	compensate: (data: TCompensationData, state: OrchestrationState) => Promise<void>
}
