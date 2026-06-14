import { runGemmaPlanningStep } from "@repo/agent-engine"
import { executeAstTransformationStep } from "@repo/ast-tooling"
import { ENGINE_STATUS, OrchestrationState } from "@repo/protocol"

export async function executeUserIntentWorkflow(intent: string, rootDir: string): Promise<OrchestrationState> {
	let globalState: OrchestrationState = {
		userIntent: intent,
		targetDirectory: rootDir,
		status: ENGINE_STATUS.PLANNING,
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: ["Starting global core orchestration planning flow."],
	}

	// Step 1: Query Brain layer
	const planningResult = await runGemmaPlanningStep.execute(
		{
			intent: globalState.userIntent,
			availableModules: ["next-base", "auth", "database", "cms"],
		},
		globalState,
	)

	if (!planningResult.success) {
		globalState.status = ENGINE_STATUS.FAILED
		globalState.logs.push(`Planning failed: ${planningResult.error}`)
		return globalState
	}

	globalState.executionPlan.steps = planningResult.output.resolvedSteps
	globalState.status = ENGINE_STATUS.EXECUTING

	const compensations: Array<{ step: typeof executeAstTransformationStep; data: any }> = []

	// Step 2: Loop through steps sequentially using muscle layer
	for (let i = 0; i < globalState.executionPlan.steps.length; i++) {
		globalState.executionPlan.currentStepIndex = i
		const currentStep = globalState.executionPlan.steps[i]

		globalState.logs.push(`Executing operation: ${currentStep.module}:${currentStep.action}`)

		const executionResult = await executeAstTransformationStep.execute(
			{
				moduleName: currentStep.module,
				actionName: currentStep.action,
				parameters: currentStep.params,
				targetDirectory: globalState.targetDirectory,
			},
			globalState,
		)

		if (!executionResult.success) {
			globalState.status = ENGINE_STATUS.COMPENSATING
			globalState.logs.push(
				`Execution error encountered at step ${currentStep.id}. Rolling back transaction history...`,
			)

			// Execute compensation routines in exact reverse order
			for (let j = compensations.length - 1; j >= 0; j--) {
				const historyItem = compensations[j]
				await historyItem.step.compensate(historyItem.data, globalState)
				globalState.logs.push(`Rollback execution step passed successfully.`)
			}

			globalState.status = ENGINE_STATUS.FAILED
			return globalState
		}

		compensations.push({
			step: executeAstTransformationStep,
			data: executionResult.compensationData,
		})
	}

	globalState.status = ENGINE_STATUS.SUCCESS
	globalState.logs.push("System application tree synchronized successfully without compiler errors.")
	return globalState
}
