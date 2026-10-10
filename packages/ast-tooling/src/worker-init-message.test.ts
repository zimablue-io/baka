// ---------------------------------------------------------------------------
// Pinned test for the `baka init` hint the Worker emits when a
// `requiresReasoning: true` recipe is invoked without an injected LLM
// provider.
//
// The role-keyed config refactor replaces the legacy
// `baka providers use <name>` hint with the new `baka init` hint. This
// test pins the new error text so the writer cannot regress it. The
// contract covers both pre- and post-render points in the worker where a
// null LLMProvider surfaces: inside `fillReasoningTemplates`.
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestrationState } from "@repo/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { executeWorkerStep } from "./worker.js"

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

/**
 * Build a tiny project tree with one `requiresReasoning: true` recipe and
 * one handlebars template so `fillReasoningTemplates` is guaranteed to
 * enter the null-provider branch (not the "no templates" early return).
 */
function makeRequiresReasoningProject(): { root: string; packName: string; recipeId: string } {
	const root = mkdtempSync(join(tmpdir(), "baka-worker-init-message-"))
	cleanup.push(root)
	const packName = "init-hint-mod"
	const recipeId = "render-thing"
	const packRoot = join(root, "packs", packName)
	const recipeDir = join(packRoot, recipeId)
	const templatesDir = join(recipeDir, "templates")
	mkdirSync(templatesDir, { recursive: true })

	writeFileSync(
		join(packRoot, "manifest.ts"),
		`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
  name: "${packName}", version: "0.1.0", description: "fake", dependencies: [], conflictsWith: [],
  recipes: [{
    id: "${recipeId}",
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
  execute: async (): Promise<StepResponse<boolean, unknown>> => ({
    success: true,
    output: true,
    compensationData: null,
  }),
  compensate: async () => {},
}
`,
	)
	return { root, packName, recipeId }
}

function makeState(targetDirectory: string): OrchestrationState {
	return {
		userIntent: "test",
		targetDirectory,
		status: "EXECUTING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
}

describe("Worker error message — `baka init` hint when no LLM is injected", () => {
	it("emits the `baka init` hint (not the legacy `baka providers use <name>` text) when llmProvider is null", async () => {
		const { root, packName, recipeId } = makeRequiresReasoningProject()

		const result = await executeWorkerStep.execute(
			{ packName, recipeName: recipeId, parameters: {} },
			makeState(root),
			{ llmProvider: null },
		)

		expect(result.success, `worker unexpectedly succeeded: ${result.error}`).toBe(false)
		expect(result.error, `expected the baka init hint in the error; got ${result.error}`).toContain(
			"Run `baka init` to configure the worker role",
		)
		// Must NOT contain the legacy hint.
		expect(result.error, `legacy 'baka providers use' hint found; got ${result.error}`).not.toContain(
			"baka providers use",
		)
	})
})
