"use workflow"

import { orchestratePlanningStep } from "@repo/agent-engine"
import { executeAstTransformationStep } from "@repo/ast-tooling"
import type { OrchestrationState } from "@repo/protocol"
import { ENGINE_STATUS } from "@repo/protocol"

async function orchestratePlanningDurable(state: OrchestrationState) {
	"use step"
	return await orchestratePlanningStep.execute(
		{
			intent: state.userIntent,
			availableModules: ["next-base", "auth", "database", "cms"],
		},
		state,
	)
}

async function executeWorkerDurable(
	stepId: string,
	module: string,
	action: string,
	params: Record<string, any>,
	state: OrchestrationState,
) {
	"use step"
	return await executeAstTransformationStep.execute(
		{
			moduleName: module,
			actionName: action,
			parameters: params,
			targetDirectory: state.targetDirectory,
		},
		state,
	)
}

export async function featurePlanningWorkflow(intent: string, rootDir: string): Promise<OrchestrationState> {
	let globalState: OrchestrationState = {
		userIntent: intent,
		targetDirectory: rootDir,
		status: ENGINE_STATUS.PLANNING,
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: ["Starting durable orchestration planning flow."],
		artifacts: {},
	}

	// Step 1: Query Orchestrator layer as a durable step
	const planningResult = await orchestratePlanningDurable(globalState)

	if (!planningResult.success) {
		globalState.status = ENGINE_STATUS.FAILED
		globalState.logs.push(`Planning failed: ${planningResult.error}`)
		return globalState
	}

	globalState.executionPlan.steps = planningResult.output.resolvedSteps
	globalState.status = ENGINE_STATUS.EXECUTING

	// Step 2: Loop through steps sequentially using Worker layer as durable steps
	for (let i = 0; i < globalState.executionPlan.steps.length; i++) {
		globalState.executionPlan.currentStepIndex = i
		const currentStep = globalState.executionPlan.steps[i]

		globalState.logs.push(`Executing operation: ${currentStep.module}:${currentStep.action}`)

		const executionResult = await executeWorkerDurable(
			currentStep.id,
			currentStep.module,
			currentStep.action,
			currentStep.params,
			globalState,
		)

		if (!executionResult.success) {
			globalState.status = ENGINE_STATUS.FAILED
			globalState.logs.push(`Execution error: ${executionResult.error}`)
			return globalState
		}
	}

	globalState.status = ENGINE_STATUS.SUCCESS
	globalState.logs.push("System application tree synchronized successfully.")
	return globalState
}
