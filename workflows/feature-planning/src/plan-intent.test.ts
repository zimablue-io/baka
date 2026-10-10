import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, LLMResponse, ResolvedPlan } from "@repo/protocol"
import { ENGINE_STATUS } from "@repo/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { featurePlanningWorkflow } from "./plan-intent"

// ---------------------------------------------------------------------------
// featurePlanningWorkflow tests against REAL on-disk fixture packs (no
// discovery mocks): the workflow must see exactly what the engine's single
// discovery implementation sees, and must refuse plans that reference an
// recipe id exported by two different packs (architecture decision 12).
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

function writeFixturePack(root: string, name: string, recipeIds: string[]): void {
	const packDir = join(root, "packs", name)
	mkdirSync(packDir, { recursive: true })
	const recipes = recipeIds
		.map(
			(id) =>
				`{ id: "${id}", description: "${id}", params: [], requiresReasoning: false, filePatterns: [], validators: [] }`,
		)
		.join(", ")
	writeFileSync(
		join(packDir, "manifest.ts"),
		`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "${name}",
	version: "0.1.0",
	description: "fixture ${name}",
	dependencies: [],
	conflictsWith: [],
	recipes: [${recipes}],
	packValidators: [],
}
`,
	)
	for (const id of recipeIds) {
		mkdirSync(join(packDir, id), { recursive: true })
		writeFileSync(join(packDir, id, "recipe.ts"), "export const actRecipe = {}\n")
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
	it("resolves a plan and returns SUCCESS when at least one pack is available", async () => {
		const root = makeTempDir("baka-plan-ok-")
		writeFixturePack(root, "test-mod", ["scaffold"])
		const provider = fakeProviderReturning({
			resolvedSteps: [{ id: "step-1", pack: "test-mod", recipe: "scaffold", params: {} }],
		})

		const result = await featurePlanningWorkflow("scaffold auth", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.executionPlan.steps).toHaveLength(1)
		expect(result.logs.some((l) => l.startsWith("[plan]"))).toBe(true)
	})

	it("sees packs installed in the project marketplace scope (<root>/.baka/packs)", async () => {
		const root = makeTempDir("baka-plan-project-scope-")
		// Same fixture shape as the tree scope but under the project marketplace.
		const packDir = join(root, ".baka", "packs", "market-mod")
		mkdirSync(join(packDir, "act"), { recursive: true })
		writeFileSync(
			join(packDir, "manifest.ts"),
			`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "market-mod",
	version: "0.1.0",
	description: "project marketplace fixture",
	dependencies: [],
	conflictsWith: [],
	recipes: [{ id: "act", description: "act", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
	packValidators: [],
}
`,
		)
		writeFileSync(join(packDir, "act", "recipe.ts"), "export const actRecipe = {}\n")
		const provider = fakeProviderReturning({
			resolvedSteps: [{ id: "step-1", pack: "market-mod", recipe: "act", params: {} }],
		})

		const result = await featurePlanningWorkflow("use the marketplace pack", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.executionPlan.steps[0].pack).toBe("market-mod")
	})

	it("returns FAILED with a clear diagnostic when no packs are discovered", async () => {
		const root = makeTempDir("baka-plan-empty-")
		const provider = fakeProviderReturning({ resolvedSteps: [] })

		const result = await featurePlanningWorkflow("scaffold auth", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.FAILED)
		expect(result.logs.some((l) => /no packs were discovered/i.test(l))).toBe(true)
		expect(result.executionPlan.steps).toEqual([])
	})

	it("refuses a plan that references a recipe id exported by two different packs", async () => {
		const root = makeTempDir("baka-plan-collide-")
		writeFixturePack(root, "mod-a", ["collide"])
		writeFixturePack(root, "mod-b", ["collide"])
		const provider = fakeProviderReturning({
			resolvedSteps: [{ id: "step-1", pack: "mod-a", recipe: "collide", params: {} }],
		})

		const result = await featurePlanningWorkflow("run the colliding recipe", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.FAILED)
		const refusal = result.logs.find((l) => /collide/.test(l) && /mod-a/.test(l) && /mod-b/.test(l))
		expect(refusal, "expected a refusal log naming both mod-a and mod-b").toBeDefined()
	})

	it("does not refuse a plan that avoids the ambiguous recipe id", async () => {
		const root = makeTempDir("baka-plan-no-collide-")
		writeFixturePack(root, "mod-a", ["collide", "unique-a"])
		writeFixturePack(root, "mod-b", ["collide"])
		const provider = fakeProviderReturning({
			resolvedSteps: [{ id: "step-1", pack: "mod-a", recipe: "unique-a", params: {} }],
		})

		const result = await featurePlanningWorkflow("run the unique recipe", root, provider)

		expect(result.status).toBe(ENGINE_STATUS.SUCCESS)
		expect(result.executionPlan.steps).toHaveLength(1)
	})
})
