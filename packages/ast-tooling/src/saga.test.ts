import {
	AgentRole,
	ENGINE_STATUS,
	type OrchestrationState,
	type ResolvedPlan,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import { describe, expect, it } from "vitest"
import { runSaga } from "./saga.js"

function freshState(): OrchestrationState {
	return {
		userIntent: "test",
		targetDirectory: "/tmp",
		status: "PLANNING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
}

function stepOk(name: string): WorkflowStep<unknown, unknown, unknown> {
	return {
		name,
		role: AgentRole.WORKER,
		execute: async (input): Promise<StepResponse<unknown, unknown>> => {
			return { success: true, output: input, compensationData: { name, input } }
		},
		compensate: async (data) => {
			throw new Error(`compensate called for ${(data as { name: string }).name}`)
		},
	}
}

function stepFails(name: string, message: string): WorkflowStep<unknown, unknown, unknown> {
	return {
		name,
		role: AgentRole.WORKER,
		execute: async (): Promise<StepResponse<unknown, unknown>> => {
			return { success: false, output: null, compensationData: { name }, error: message }
		},
		compensate: async () => {},
	}
}

function planWith(steps: Array<{ id: string; module: string; action: string }>): ResolvedPlan {
	return {
		resolvedSteps: steps.map((s) => ({ id: s.id, module: s.module, action: s.action, params: {} })),
	}
}

describe("runSaga", () => {
	it("runs an empty plan to SUCCESS", async () => {
		const state = freshState()
		const result = await runSaga(planWith([]), state, { llmProvider: null }, new Map())
		expect(result.state.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.completed).toEqual([])
		expect(result.failed).toBeNull()
	})

	it("runs a single-step plan to SUCCESS", async () => {
		const state = freshState()
		const steps = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
		steps.set("m:a", stepOk("m:a"))
		const result = await runSaga(planWith([{ id: "1", module: "m", action: "a" }]), state, { llmProvider: null }, steps)
		expect(result.state.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.completed).toHaveLength(1)
	})

	it("fails and rolls back a multi-step plan on the second step", async () => {
		const state = freshState()
		const steps = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
		steps.set("m:a", stepOk("m:a"))
		steps.set("m:b", stepFails("m:b", "boom"))
		const result = await runSaga(
			planWith([
				{ id: "1", module: "m", action: "a" },
				{ id: "2", module: "m", action: "b" },
			]),
			state,
			{ llmProvider: null },
			steps,
		)
		expect(result.state.status).toBe(ENGINE_STATUS.FAILED)
		expect(result.failed).toEqual({ id: "2", error: "boom" })
		// Rollback happens even though the step has a no-op compensate.
		expect(result.state.status).toBe(ENGINE_STATUS.FAILED)
		// Logs mention the rollback.
		expect(result.state.logs.some((l) => l.includes("rolling back"))).toBe(true)
	})

	it("fails fast if a step is missing from the registry", async () => {
		const state = freshState()
		const result = await runSaga(
			planWith([{ id: "1", module: "missing", action: "x" }]),
			state,
			{ llmProvider: null },
			new Map(),
		)
		expect(result.state.status).toBe(ENGINE_STATUS.FAILED)
		expect(result.failed?.error).toMatch(/no worker step registered/)
	})

	it("captures thrown errors from a step's execute", async () => {
		const state = freshState()
		const steps = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
		steps.set("m:throw", {
			name: "throw",
			role: AgentRole.WORKER,
			execute: async () => {
				throw new Error("kaboom")
			},
			compensate: async () => {},
		})
		const result = await runSaga(
			planWith([{ id: "1", module: "m", action: "throw" }]),
			state,
			{ llmProvider: null },
			steps,
		)
		expect(result.state.status).toBe(ENGINE_STATUS.FAILED)
		expect(result.failed?.error).toContain("kaboom")
	})

	it("captures the step's rich output on every completed step (rich-action-output-propagation)", async () => {
		const state = freshState()
		const steps = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
		steps.set("m:rich", {
			name: "rich",
			role: AgentRole.WORKER,
			execute: async (): Promise<StepResponse<unknown, unknown>> => ({
				success: true,
				output: { kind: "lint", errors: 3, diagnostics: [{ rule: "noAny", file: "a.ts" }] },
				compensationData: { tagged: true },
			}),
			compensate: async () => {},
		})
		const result = await runSaga(
			planWith([{ id: "1", module: "m", action: "rich" }]),
			state,
			{ llmProvider: null },
			steps,
		)

		expect(result.state.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.completed).toHaveLength(1)
		// The saga contract must carry the action's output through so the
		// apply surfaces (CLI + MCP) can serialize it. Without this, every
		// rich payload collapses to the boolean success flag.
		expect(result.completed[0]?.output).toEqual({
			kind: "lint",
			errors: 3,
			diagnostics: [{ rule: "noAny", file: "a.ts" }],
		})
		// Sanity: compensationData still flows (the worker envelope is kept for
		// rollback and the unwrapped value still feeds validators).
		expect(result.completed[0]?.compensationData).toEqual({ tagged: true })
	})
})
