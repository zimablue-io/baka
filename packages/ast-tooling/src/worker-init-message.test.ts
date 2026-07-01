// ---------------------------------------------------------------------------
// Pinned test for the `baka init` hint the Worker emits when a
// `requiresReasoning: true` action is invoked without an injected LLM
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
 * Build a tiny project tree with one `requiresReasoning: true` action and
 * one handlebars template so `fillReasoningTemplates` is guaranteed to
 * enter the null-provider branch (not the "no templates" early return).
 */
function makeRequiresReasoningProject(): { root: string; moduleName: string; actionId: string } {
	const root = mkdtempSync(join(tmpdir(), "baka-worker-init-message-"))
	cleanup.push(root)
	const moduleName = "init-hint-mod"
	const actionId = "render-thing"
	const moduleRoot = join(root, "modules", moduleName)
	const actionDir = join(moduleRoot, actionId)
	const templatesDir = join(actionDir, "templates")
	mkdirSync(templatesDir, { recursive: true })

	writeFileSync(
		join(moduleRoot, "manifest.ts"),
		`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
  name: "${moduleName}", version: "0.1.0", description: "fake", dependencies: [], conflictsWith: [],
  actions: [{
    id: "${actionId}",
    description: "renders a thing",
    params: [],
    requiresReasoning: true,
    filePatterns: [],
    validators: [],
  }],
  moduleValidators: [],
}
`,
	)
	writeFileSync(join(templatesDir, "thing.md.hbs"), "hello world")

	writeFileSync(
		join(actionDir, "action.ts"),
		`import { AgentRole, type StepResponse, type WorkflowStep } from "@repo/protocol"
export const renderThingAction: WorkflowStep<unknown, boolean, unknown> = {
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
	return { root, moduleName, actionId }
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
		const { root, moduleName, actionId } = makeRequiresReasoningProject()

		const result = await executeWorkerStep.execute(
			{ moduleName, actionName: actionId, parameters: {} },
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
