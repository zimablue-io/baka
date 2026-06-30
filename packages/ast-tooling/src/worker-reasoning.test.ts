import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, LLMRequest, OrchestrationState } from "@repo/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { executeWorkerStep } from "./worker.js"

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanup: string[] = []

afterEach(() => {
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Worker reasoning integration — fillReasoningTemplates end-to-end", () => {
	it("calls the LLM, passes renderedTemplates to the action, and writes generated content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-worker-reasoning-"))
		cleanup.push(dir)

		// -- Build a fake project with a requiresReasoning action --

		const moduleRoot = join(dir, "modules", "test-mod")
		const actionDir = join(moduleRoot, "renderThing")
		const templatesDir = join(actionDir, "templates")
		mkdirSync(templatesDir, { recursive: true })

		// manifest.ts — action declares requiresReasoning: true
		writeFileSync(
			join(moduleRoot, "manifest.ts"),
			`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "test-mod", version: "0.1.0", description: "fake", dependencies: [], conflictsWith: [],
	actions: [{
		id: "renderThing",
		description: "renders a thing",
		params: [{ name: "name", type: "string", required: true, description: "name" }],
		requiresReasoning: true,
		filePatterns: [],
		validators: [],
	}],
	moduleValidators: [],
}
`,
		)

		// template — handlebars pre-rendered with params, then sent to LLM
		writeFileSync(join(templatesDir, "output.md.hbs"), "Generate content for {{name}}")

		// action.ts — reads renderedTemplates["output.md"] and writes to target
		writeFileSync(
			join(actionDir, "action.ts"),
			`import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { AgentRole, type StepResponse, type WorkflowStep } from "@repo/protocol"

export interface Input { name: string; renderedTemplates?: Record<string, string> }
export interface Data { path: string }

export const renderThingAction: WorkflowStep<Input, boolean, Data> = {
	name: "render-thing",
	role: AgentRole.WORKER,
	execute: async (input, state): Promise<StepResponse<boolean, Data>> => {
		const content = input.renderedTemplates?.["output.md"] ?? "FALLBACK"
		const full = join(state.targetDirectory, "output.md")
		writeFileSync(full, content, "utf-8")
		return { success: true, output: true, compensationData: { path: full } }
	},
	compensate: async (data) => {
		const { rmSync, existsSync } = require("node:fs") as typeof import("node:fs")
		if (data.path && existsSync(data.path)) rmSync(data.path, { force: true })
	},
}
`,
		)

		// -- Fake LLM provider that tracks calls --
		let callCount = 0
		const fakeProvider: LLMProvider = {
			name: "fake",
			chat: async <T = unknown>(_req: LLMRequest) => {
				callCount++
				return {
					content: { content: "generated content for test" } as T,
					usage: { promptTokens: 0, completionTokens: 0 },
					raw: null,
				}
			},
			validateConfig: () => {},
		}

		const state: OrchestrationState = {
			userIntent: "test",
			targetDirectory: dir,
			status: "EXECUTING",
			executionPlan: { steps: [], currentStepIndex: 0 },
			logs: [],
			artifacts: {},
		}

		// -- Execute the worker step --
		const result = await executeWorkerStep.execute(
			{ moduleName: "test-mod", actionName: "renderThing", parameters: { name: "test" } },
			state,
			{ llmProvider: fakeProvider },
		)

		// -- Assertions --
		expect(result.success, `worker failed: ${result.error}`).toBe(true)
		expect(callCount, "LLM was not called for reasoning").toBeGreaterThan(0)
		expect(existsSync(join(dir, "output.md")), "output file was not created").toBe(true)
		expect(readFileSync(join(dir, "output.md"), "utf-8")).toBe("generated content for test")
	})
})
