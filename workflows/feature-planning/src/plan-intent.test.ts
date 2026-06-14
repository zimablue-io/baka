import { ENGINE_STATUS } from "@repo/protocol"
import { describe, expect, it, vi } from "vitest"
import { featurePlanningWorkflow } from "./plan-intent"

// Mocking dependencies
vi.mock("@repo/agent-engine", () => ({
	orchestratePlanningStep: {
		execute: vi.fn().mockResolvedValue({
			success: true,
			output: { resolvedSteps: [{ id: "1", module: "test", action: "init", params: {} }] },
			compensationData: null,
		}),
	},
}))

vi.mock("@repo/ast-tooling", () => ({
	executeAstTransformationStep: {
		execute: vi.fn().mockResolvedValue({
			success: true,
			output: true,
			compensationData: {},
		}),
		compensate: vi.fn(),
	},
}))

describe("featurePlanningWorkflow", () => {
	it("should orchestrate planning and execution", async () => {
		const result = await featurePlanningWorkflow("scaffold auth", "/tmp")

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.logs).toContain("System application tree synchronized successfully.")
	})
})
