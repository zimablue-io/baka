import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	ENGINE_STATUS,
	type LLMProvider,
	type OrchestrationState,
	type ResolvedPlan,
	type StepResponse,
	type WorkflowStep,
} from "@repo/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { runSaga } from "./saga.js"
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
 * Builds a fake project that contains a single `mod` module with a single
 * `do-thing` action. The action writes a file and returns its path as
 * compensation data. The SAGA test below exercises the full Worker pipeline
 * without the rest of the baka CLI in the loop.
 */
function makeProject(): { root: string; moduleName: string; actionId: string } {
	const root = mkdtempSync(join(tmpdir(), "baka-worker-"))
	cleanup.push(root)
	const moduleName = "mod"
	// Action id must produce a valid TS identifier when concatenated with "Action"
	// (the baka convention: exported symbol is `${actionId}Action`).
	const actionId = "doThing"
	const moduleRoot = join(root, "modules", moduleName, actionId)
	mkdirSync(moduleRoot, { recursive: true })
	writeFileSync(
		join(root, "modules", moduleName, "manifest.ts"),
		`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "${moduleName}", version: "0.1.0", description: "fake", dependencies: [], conflictsWith: [],
	actions: [{ id: "${actionId}", description: "writes a file", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
	)
	writeFileSync(
		join(moduleRoot, "action.ts"),
		`import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { AgentRole, type StepResponse, type WorkflowStep } from "@repo/protocol"

export interface Input { moduleName: string; actionName: string; parameters: { name: string } }
export interface Data { path: string }

export const doThingAction: WorkflowStep<Input, boolean, Data> = {
	name: "do-thing",
	role: AgentRole.WORKER,
	execute: async (input, state): Promise<StepResponse<boolean, Data>> => {
		try {
			const name = input.parameters?.name ?? "default"
			const full = join(state.targetDirectory, name + ".txt")
			mkdirSync(join(state.targetDirectory, "out"), { recursive: true })
			writeFileSync(full, "hello", "utf-8")
			return { success: true, output: true, compensationData: { path: full } }
		} catch (err) {
			return { success: false, output: false, compensationData: { path: "" }, error: err instanceof Error ? err.message : String(err) }
		}
	},
	compensate: async (data) => {
		const { rmSync, existsSync } = require("node:fs") as typeof import("node:fs")
		if (data.path && existsSync(data.path)) rmSync(data.path, { force: true })
	},
}
`,
	)
	return { root, moduleName, actionId }
}

function planWith(
	steps: Array<{ id: string; module: string; action: string; params: Record<string, unknown> }>,
): ResolvedPlan {
	return { resolvedSteps: steps }
}

const fakeProvider: LLMProvider = {
	name: "fake",
	chat: async <T = unknown>() => ({ content: {} as T, usage: { promptTokens: 0, completionTokens: 0 }, raw: null }),
	validateConfig: () => {},
}

/** Loads the action.ts file via jiti and returns a WorkflowStep. */
async function loadActionViaJiti(projectRoot: string, moduleName: string, actionId: string) {
	const { createJiti } = await import("jiti")
	const jiti = createJiti(projectRoot, { interopDefault: true })
	const path = join(projectRoot, "modules", moduleName, actionId, "action.ts")
	const mod = jiti(path) as Record<string, unknown>
	const expected = `${actionId}Action`
	const step = (mod[expected] ?? mod.default) as WorkflowStep<unknown, unknown, unknown> | undefined
	if (!step) throw new Error(`expected ${expected} in ${path}`)
	return step
}

describe("Worker end-to-end (jiti + SAGA)", () => {
	it("loads a real action, runs it via the SAGA, and produces the file", async () => {
		const { root, moduleName, actionId } = makeProject()
		const step = await loadActionViaJiti(root, moduleName, actionId)
		const stepsByKey = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
		stepsByKey.set(`${moduleName}:${actionId}`, step)

		const state: OrchestrationState = {
			userIntent: "test",
			targetDirectory: root,
			status: "PLANNING",
			executionPlan: { steps: [], currentStepIndex: 0 },
			logs: [],
			artifacts: {},
		}
		const plan = planWith([{ id: "1", module: moduleName, action: actionId, params: { name: "hello" } }])
		const result = await runSaga(plan, state, { llmProvider: fakeProvider }, stepsByKey)
		expect(result.state.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(existsSync(join(root, "hello.txt"))).toBe(true)
		expect(readFileSync(join(root, "hello.txt"), "utf-8")).toBe("hello")
	})

	it("rolls back the produced file when a later step fails", async () => {
		const { root, moduleName, actionId } = makeProject()
		const step = await loadActionViaJiti(root, moduleName, actionId)
		const stepsByKey = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
		stepsByKey.set(`${moduleName}:${actionId}`, step)
		// Inject a synthetic failing step under a different key.
		stepsByKey.set("other:fail", {
			name: "fail",
			role: "worker" as never,
			execute: async (): Promise<StepResponse<unknown, unknown>> => ({
				success: false,
				output: null,
				compensationData: null,
				error: "boom",
			}),
			compensate: async () => {},
		} as WorkflowStep<unknown, unknown, unknown>)

		const state: OrchestrationState = {
			userIntent: "test",
			targetDirectory: root,
			status: "PLANNING",
			executionPlan: { steps: [], currentStepIndex: 0 },
			logs: [],
			artifacts: {},
		}
		const plan = planWith([
			{ id: "1", module: moduleName, action: actionId, params: { name: "alpha" } },
			{ id: "2", module: "other", action: "fail", params: {} },
		])
		const result = await runSaga(plan, state, { llmProvider: fakeProvider }, stepsByKey)
		expect(result.state.status).toBe(ENGINE_STATUS.FAILED)
		// Rollback must have removed the file the first step created.
		expect(existsSync(join(root, "alpha.txt"))).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// Worker error-message contract — role-keyed config refactor
//
// The role-keyed config refactor replaces the legacy `baka providers
// use <name>` hint with the new `baka init` hint. This test pins the
// new error text so the writer cannot regress the user-facing message.
// ---------------------------------------------------------------------------

describe("Worker error message — `baka init` hint when no LLM is injected for a requiresReasoning action", () => {
	it("emits the `baka init` error message when requiresReasoning is true and the LLMProvider is null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-worker-init-hint-"))
		cleanup.push(dir)

		const moduleRoot = join(dir, "modules", "init-hint-mod")
		const actionDir = join(moduleRoot, "render-thing")
		const templatesDir = join(actionDir, "templates")
		mkdirSync(templatesDir, { recursive: true })

		// manifest with a requiresReasoning action
		writeFileSync(
			join(moduleRoot, "manifest.ts"),
			`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
  name: "init-hint-mod", version: "0.1.0", description: "fake", dependencies: [], conflictsWith: [],
  actions: [{
    id: "render-thing",
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
		// A handlebars template so the worker takes the reasoning branch.
		writeFileSync(join(templatesDir, "thing.md.hbs"), "hello world")

		writeFileSync(
			join(actionDir, "action.ts"),
			`import { AgentRole, type StepResponse, type WorkflowStep } from "@repo/protocol"
export const renderThingAction: WorkflowStep<unknown, boolean, unknown> = {
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
			{ moduleName: "init-hint-mod", actionName: "render-thing", parameters: {} },
			state,
			{ llmProvider: null },
		)

		expect(result.success, `worker unexpectedly succeeded: ${result.error}`).toBe(false)
		expect(result.error, `expected the baka init hint in the error; got ${result.error}`).toContain(
			"Run `baka init` to configure the worker role",
		)
	})
})
