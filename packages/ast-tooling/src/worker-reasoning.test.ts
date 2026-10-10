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
	it("calls the LLM, passes renderedTemplates to the recipe, and writes generated content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-worker-reasoning-"))
		cleanup.push(dir)

		// -- Build a fake project with a requiresReasoning recipe --

		const packRoot = join(dir, "packs", "test-mod")
		const recipeDir = join(packRoot, "renderThing")
		const templatesDir = join(recipeDir, "templates")
		mkdirSync(templatesDir, { recursive: true })

		// manifest.ts — recipe declares requiresReasoning: true
		writeFileSync(
			join(packRoot, "manifest.ts"),
			`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "test-mod", version: "0.1.0", description: "fake", dependencies: [], conflictsWith: [],
	recipes: [{
		id: "renderThing",
		description: "renders a thing",
		params: [{ name: "name", type: "string", required: true, description: "name" }],
		requiresReasoning: true,
		filePatterns: [],
		validators: [],
	}],
	packValidators: [],
}
`,
		)

		// template — handlebars pre-rendered with params, then sent to LLM
		writeFileSync(
			join(templatesDir, "output.md.hbs"),
			'# {{name}}\n{{#slot "body" kind="prose" max=80}}one sentence{{/slot}}\n',
		)

		// recipe.ts is omitted: templates/ is the output tree.

		// -- Fake LLM provider that tracks calls --
		let callCount = 0
		const fakeProvider: LLMProvider = {
			name: "fake",
			chat: async <T = unknown>(_req: LLMRequest) => {
				callCount++
				return {
					content: { value: "generated content for test" } as T,
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
			{ packName: "test-mod", recipeName: "renderThing", parameters: { name: "test" } },
			state,
			{ llmProvider: fakeProvider },
		)

		// -- Assertions --
		expect(result.success, `worker failed: ${result.error}`).toBe(true)
		expect(callCount, "LLM was not called for reasoning").toBeGreaterThan(0)
		expect(existsSync(join(dir, "output.md")), "output file was not created").toBe(true)
		expect(readFileSync(join(dir, "output.md"), "utf-8")).toBe("# test\ngenerated content for test\n")
	})

	// The role-keyed config refactor replaces the legacy
	// `baka providers use <name>` hint with the new
	// `baka init` hint. This test pins the new text in the
	// requiresReasoning path so the writer cannot regress it.
	it("emits the `baka init` hint when requiresReasoning is true and the LLMProvider is null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-worker-reasoning-hint-"))
		cleanup.push(dir)

		const packRoot = join(dir, "packs", "reasoning-hint-mod")
		const recipeDir = join(packRoot, "render-thing")
		const templatesDir = join(recipeDir, "templates")
		mkdirSync(templatesDir, { recursive: true })

		writeFileSync(
			join(packRoot, "manifest.ts"),
			`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
  name: "reasoning-hint-mod", version: "0.1.0", description: "fake", dependencies: [], conflictsWith: [],
  recipes: [{
    id: "render-thing",
    description: "renders a thing",
    params: [],
    requiresReasoning: true,
    filePatterns: [],
    validators: [],
  }],
  packValidators: [],
}
`,
		)
		writeFileSync(join(templatesDir, "thing.md.hbs"), '{{#slot "body" kind="prose"}}one sentence{{/slot}}\n')

		writeFileSync(
			join(recipeDir, "recipe.ts"),
			`import { AgentRole, type StepResponse, type WorkflowStep } from "@repo/protocol"
export const renderThingRecipe: WorkflowStep<unknown, boolean, unknown> = {
  name: "render-thing",
  role: AgentRole.WORKER,
  execute: async (): Promise<StepResponse<boolean, unknown>> => ({ success: true, output: true, compensationData: null }),
  compensate: async () => {},
}
`,
		)

		const state: OrchestrationState = {
			userIntent: "test",
			targetDirectory: dir,
			status: "EXECUTING",
			executionPlan: { steps: [], currentStepIndex: 0 },
			logs: [],
			artifacts: {},
		}

		const result = await executeWorkerStep.execute(
			{ packName: "reasoning-hint-mod", recipeName: "render-thing", parameters: {} },
			state,
			{ llmProvider: null },
		)

		expect(result.success, `worker unexpectedly succeeded: ${result.error}`).toBe(false)
		expect(result.error, `expected the baka init hint in the error; got ${result.error}`).toContain(
			"Run `baka init` to configure the worker role",
		)
	})
})
