import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
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

/** Snapshots a directory tree as a sorted list of relative paths + SHA-256 content hashes. */
function snapshotTree(root: string): string[] {
	const lines: string[] = []
	function walk(dir: string) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name)
			const rel = relative(root, full)
			if (entry.isDirectory()) {
				lines.push(`${rel}/`)
				walk(full)
			} else if (entry.isFile()) {
				const hash = createHash("sha256").update(readFileSync(full)).digest("hex")
				lines.push(`${rel}:${hash}`)
			}
		}
	}
	walk(root)
	return lines.sort()
}

/**
 * Builds a fake consumer project with a single pack `comp-mod` containing a
 * `write` recipe. The recipe creates `created.txt` and appends to a pre-existing
 * `config.txt`, recording the original `config.txt` content in its compensation
 * data. Its `compensate` restores `config.txt` and removes `created.txt`.
 */
function makeCompensationProject(): { root: string; packName: string; recipeId: string } {
	const root = mkdtempSync(join(tmpdir(), "baka-saga-comp-"))
	cleanup.push(root)

	const packName = "comp-mod"
	const recipeId = "write"
	const packRoot = join(root, "packs", packName)
	const recipeDir = join(packRoot, recipeId)
	mkdirSync(recipeDir, { recursive: true })
	writeFileSync(join(root, "config.txt"), "original", "utf-8")

	writeFileSync(
		join(packRoot, "manifest.ts"),
		`export const Manifest = {
	name: "${packName}",
	version: "0.1.0",
	description: "compensation test pack",
	dependencies: [],
	conflictsWith: [],
	recipes: [{
		id: "${recipeId}",
		description: "writes a file and edits config",
		params: [],
		requiresReasoning: false,
		filePatterns: ["created.txt"],
		validators: [],
	}],
	packValidators: [],
}
`,
	)

	writeFileSync(
		join(recipeDir, "recipe.ts"),
		`const { writeFileSync, readFileSync, rmSync, existsSync } = require("node:fs")
const { join } = require("node:path")

export const writeRecipe = {
	name: "write",
	role: "worker",
	execute: async (_input, state) => {
		const target = state.targetDirectory
		const created = join(target, "created.txt")
		const config = join(target, "config.txt")
		const original = existsSync(config) ? readFileSync(config, "utf-8") : ""
		writeFileSync(created, "i was created", "utf-8")
		writeFileSync(config, original + "\\n" + "modified", "utf-8")
		return { success: true, output: true, compensationData: { original, created } }
	},
	compensate: async (data, state) => {
		const { writeFileSync, rmSync, existsSync } = require("node:fs")
		const { join } = require("node:path")
		const target = state?.targetDirectory ?? "."
		if (data.created) rmSync(data.created, { force: true })
		writeFileSync(join(target, "config.txt"), data.original, "utf-8")
	},
}
`,
	)

	return { root, packName, recipeId }
}

function planWith(
	steps: Array<{ id: string; pack: string; recipe: string; params: Record<string, unknown> }>,
): ResolvedPlan {
	return { resolvedSteps: steps }
}

const fakeProvider: LLMProvider = {
	name: "fake",
	chat: async <T = unknown>() => ({ content: {} as T, usage: { promptTokens: 0, completionTokens: 0 }, raw: null }),
	validateConfig: () => {},
}

describe("SAGA compensation through executeWorkerStep production wiring", () => {
	it("leaves the consumer tree byte-identical when a later step fails", async () => {
		const { root, packName, recipeId } = makeCompensationProject()
		const before = snapshotTree(root)

		const stepsByKey = new Map<string, WorkflowStep<unknown, unknown, unknown>>()
		stepsByKey.set(`${packName}:${recipeId}`, executeWorkerStep as unknown as WorkflowStep<unknown, unknown, unknown>)
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
			{ id: "1", pack: packName, recipe: recipeId, params: {} },
			{ id: "2", pack: "other", recipe: "fail", params: {} },
		])
		const result = await runSaga(plan, state, { llmProvider: fakeProvider }, stepsByKey)

		expect(result.state.status).toBe(ENGINE_STATUS.FAILED)
		expect(existsSync(join(root, "created.txt"))).toBe(false)
		expect(readFileSync(join(root, "config.txt"), "utf-8")).toBe("original")
		expect(snapshotTree(root)).toEqual(before)
		expect(state.logs.some((l) => l.includes("compensating"))).toBe(true)
	})
})

describe("Worker reasoning pollution", () => {
	it("does not leave out/ or templates copy in the consumer tree after a successful reasoning run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-worker-pollution-"))
		cleanup.push(dir)

		const packName = "pollution-mod"
		const recipeId = "render"
		const packRoot = join(dir, "packs", packName)
		const recipeDir = join(packRoot, recipeId)
		const templatesDir = join(recipeDir, "templates")
		mkdirSync(templatesDir, { recursive: true })
		writeFileSync(
			join(templatesDir, "page.md.hbs"),
			'Hello {{name}}\n{{#slot "tag" kind="prose" max=40}}one word{{/slot}}\n',
		)

		writeFileSync(
			join(packRoot, "manifest.ts"),
			`export const Manifest = {
	name: "${packName}",
	version: "0.1.0",
	description: "pollution test",
	dependencies: [],
	conflictsWith: [],
	recipes: [{
		id: "${recipeId}",
		description: "renders a page",
		params: [{ name: "name", type: "string", required: true, description: "name" }],
		requiresReasoning: true,
		filePatterns: ["page.md"],
		validators: [],
	}],
	packValidators: [],
}
`,
		)

		// templates/ is the output tree; no recipe.ts author.

		const fakeProvider: LLMProvider = {
			name: "fake",
			chat: async <T = unknown>() => ({
				content: { value: "generated" } as T,
				usage: { promptTokens: 0, completionTokens: 0 },
				raw: null,
			}),
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

		const result = await executeWorkerStep.execute(
			{ packName, recipeName: recipeId, parameters: { name: "world" } },
			state,
			{ llmProvider: fakeProvider },
		)

		expect(result.success, result.error).toBe(true)
		expect(existsSync(join(dir, "page.md"))).toBe(true)
		expect(readFileSync(join(dir, "page.md"), "utf-8")).toBe("Hello world\ngenerated\n")
		expect(existsSync(join(dir, "packs", packName, recipeId, "out"))).toBe(false)
	})
})
