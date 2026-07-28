import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, LLMResponse, ResolvedPlan } from "@repo/protocol"
import { ENGINE_STATUS } from "@repo/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { featurePlanningWorkflow } from "./plan-intent"

// ---------------------------------------------------------------------------
// featurePlanningWorkflow tests against REAL on-disk fixture modules (no
// discovery mocks): the workflow must see exactly what the engine's single
// discovery implementation sees, and must refuse plans that reference an
// action id exported by two different modules (architecture decision 12).
// ---------------------------------------------------------------------------

const cleanup: string[] = []
const prevHome = process.env.HOME

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	cleanup.push(dir)
	return dir
}

afterEach(() => {
	process.env.HOME = prevHome
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

beforeEach(() => {
	// Hermetic user scope and preferences lookup.
	process.env.HOME = makeTempDir("baka-plan-home-")
})

function writeFixtureModule(root: string, name: string, actionIds: string[]): void {
	const moduleDir = join(root, "modules", name)
	mkdirSync(moduleDir, { recursive: true })
	const actions = actionIds
		.map(
			(id) =>
				`{ id: "${id}", description: "${id}", params: [], requiresReasoning: false, filePatterns: [], validators: [] }`,
		)
		.join(", ")
	writeFileSync(
		join(moduleDir, "manifest.ts"),
		`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "${name}",
	version: "0.1.0",
	description: "fixture ${name}",
	dependencies: [],
	conflictsWith: [],
	actions: [${actions}],
	moduleValidators: [],
}
`,
	)
	for (const id of actionIds) {
		mkdirSync(join(moduleDir, id), { recursive: true })
		writeFileSync(join(moduleDir, id, "action.ts"), "export const actAction = {}\n")
	}
}

/** A fake LLM provider whose chat() returns the scripted plan. */
function fakeProviderReturning(plan: ResolvedPlan): LLMProvider {
	return {
		name: "fake",
		chat: vi.fn().mockResolvedValue({
			content: plan,
			usage: { promptTokens: 1, completionTokens: 1 },
			raw: null,
		} satisfies LLMResponse<unknown>),
		validateConfig: () => {},
	}
}

describe("featurePlanningWorkflow", () => {
	it("resolves a plan and returns SUCCESS when at least one module is available", async () => {
		const root = makeTempDir("baka-plan-ok-")
		writeFixtureModule(root, "test-mod", ["scaffold"])
		const provider = fakeProviderReturning({
			resolvedSteps: [{ id: "step-1", module: "test-mod", action: "scaffold", params: {} }],
		})

		const result = await featurePlanningWorkflow("scaffold auth", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.executionPlan.steps).toHaveLength(1)
		expect(result.logs.some((l) => l.startsWith("[plan]"))).toBe(true)
	})

	it("sees modules installed in the project marketplace scope (<root>/.baka/modules)", async () => {
		const root = makeTempDir("baka-plan-project-scope-")
		// Same fixture shape as the tree scope but under the project marketplace.
		const moduleDir = join(root, ".baka", "modules", "market-mod")
		mkdirSync(join(moduleDir, "act"), { recursive: true })
		writeFileSync(
			join(moduleDir, "manifest.ts"),
			`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "market-mod",
	version: "0.1.0",
	description: "project marketplace fixture",
	dependencies: [],
	conflictsWith: [],
	actions: [{ id: "act", description: "act", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	moduleValidators: [],
}
`,
		)
		writeFileSync(join(moduleDir, "act", "action.ts"), "export const actAction = {}\n")
		const provider = fakeProviderReturning({
			resolvedSteps: [{ id: "step-1", module: "market-mod", action: "act", params: {} }],
		})

		const result = await featurePlanningWorkflow("use the marketplace module", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.executionPlan.steps[0].module).toBe("market-mod")
	})

	it("returns FAILED with a clear diagnostic when no modules are discovered", async () => {
		const root = makeTempDir("baka-plan-empty-")
		const provider = fakeProviderReturning({ resolvedSteps: [] })

		const result = await featurePlanningWorkflow("scaffold auth", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.FAILED)
		expect(result.logs.some((l) => /no modules were discovered/i.test(l))).toBe(true)
		expect(result.executionPlan.steps).toEqual([])
	})

	it("refuses a plan that references an action id exported by two different modules", async () => {
		const root = makeTempDir("baka-plan-collide-")
		writeFixtureModule(root, "mod-a", ["collide"])
		writeFixtureModule(root, "mod-b", ["collide"])
		const provider = fakeProviderReturning({
			resolvedSteps: [{ id: "step-1", module: "mod-a", action: "collide", params: {} }],
		})

		const result = await featurePlanningWorkflow("run the colliding action", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.FAILED)
		const refusal = result.logs.find((l) => /collide/.test(l) && /mod-a/.test(l) && /mod-b/.test(l))
		expect(refusal, "expected a refusal log naming both mod-a and mod-b").toBeDefined()
	})

	it("does not refuse a plan that avoids the ambiguous action id", async () => {
		const root = makeTempDir("baka-plan-no-collide-")
		writeFixtureModule(root, "mod-a", ["collide", "unique-a"])
		writeFixtureModule(root, "mod-b", ["collide"])
		const provider = fakeProviderReturning({
			resolvedSteps: [{ id: "step-1", module: "mod-a", action: "unique-a", params: {} }],
		})

		const result = await featurePlanningWorkflow("run the unique action", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.executionPlan.steps).toHaveLength(1)
	})
})
