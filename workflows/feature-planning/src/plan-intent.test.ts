import type { LLMProvider, LLMResponse, ModuleManifest } from "@repo/protocol"
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

vi.mock("@repo/ast-tooling", () => ({
	ModuleRegistry: class {
		discover() {
			return {
				modules: [
					{
						name: "test",
						version: "0.0.0",
						description: "",
						dependencies: [],
						conflictsWith: [],
						actions: [],
						moduleValidators: [],
					} satisfies ModuleManifest,
				],
				diagnostics: [],
			}
		}
		all() {
			return []
		}
	},
	executeWorkerStep: {
		execute: vi.fn().mockResolvedValue({
			success: true,
			output: true,
			compensationData: {},
		}),
		compensate: vi.fn(),
	},
	runSaga: vi.fn().mockImplementation(async (plan: { resolvedSteps: unknown[] }, state: { status: string; logs: string[] }) => {
		state.status = "SUCCESS"
		state.logs.push("[saga] all 0 steps completed")
		return { state, completed: [], failed: null }
	}),
}))

describe("featurePlanningWorkflow", () => {
	it("orchestrates planning and finishes SUCCESS with an empty plan", async () => {
		const result = await featurePlanningWorkflow("scaffold auth", "/tmp", fakeProvider)

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.logs.some((l) => l.startsWith("[plan]"))).toBe(true)
	})
})
