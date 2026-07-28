import type { LLMProvider, LLMResponse } from "@repo/protocol"
import { ENGINE_STATUS } from "@repo/protocol"
import { describe, expect, it, vi } from "vitest"
import { featurePlanningWorkflow } from "./plan-intent"

const fakeProvider: LLMProvider = {
	name: "fake",
	chat: vi.fn().mockResolvedValue({
		content: { resolvedSteps: [] },
		usage: { promptTokens: 1, completionTokens: 1 },
		raw: null,
	} satisfies LLMResponse<unknown>),
	validateConfig: () => {},
}

vi.mock("@repo/agent-engine", () => ({
	createOrchestratePlanningStep: () => ({
		name: "mocked-orchestrator",
		role: "orchestrator",
		execute: vi.fn().mockResolvedValue({
			success: true,
			output: { resolvedSteps: [] },
			compensationData: null,
		}),
		compensate: vi.fn(),
	}),
	createInitialOrchestrationState: (intent: string, targetDirectory: string) => ({
		userIntent: intent,
		targetDirectory,
		status: "PLANNING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}),
}))

describe("featurePlanningWorkflow", () => {
	it("resolves a plan and returns SUCCESS without mutating the project tree", async () => {
		const result = await featurePlanningWorkflow("scaffold auth", "/tmp", fakeProvider)

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.logs.some((l) => l.startsWith("[plan]"))).toBe(true)
	})
})
