import { resolve } from "node:path"
import type { StepResponse, WorkflowStep } from "baka-sdk"
import { AgentRole } from "baka-sdk"
import { runBoundaryCheck } from "../_shared/helpers/run-check"

export interface ValidateBoundaryInput {
	// The action is parameterless; the boundary check is read-only and
	// operates on the baka process's cwd (== better-chat root by
	// convention). The field is present so the WorkflowStep contract
	// type-checks when invoked by the orchestrator.
	_marker?: never
}

export interface ValidateBoundaryCompensationData {
	betterChatRoot: string
	ok: boolean
	violations: number
}

const step: WorkflowStep<ValidateBoundaryInput, { ok: boolean; violations: number }, ValidateBoundaryCompensationData> =
	{
		name: "better-chat-boundaries.validate",
		role: AgentRole.WORKER,

		execute: async (
			input,
			state,
		): Promise<StepResponse<{ ok: boolean; violations: number }, ValidateBoundaryCompensationData>> => {
			void input
			const betterChatRoot = state.targetDirectory?.length ? resolve(state.targetDirectory) : resolve(process.cwd())
			const result = await runBoundaryCheck(betterChatRoot)
			const ok = result.ok
			return {
				success: ok,
				output: { ok, violations: result.diagnostics.length },
				compensationData: { betterChatRoot, ok, violations: result.diagnostics.length },
				error: ok ? undefined : `${result.diagnostics.length} boundary violation(s) detected`,
			}
		},

		compensate: async () => {
			// No-op: the action is read-only; the helper in
			// `_shared/helpers/run-check.ts` uses only read-only Node
			// `fs` calls so there is nothing for the SAGA to roll back.
		},
	}

export default step
