import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"
import { afterEach, describe, expect, it } from "vitest"
import step, { type CreateFeatureCompensationData, type CreateFeatureInput } from "./action.js"

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
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-sdd-feature-"))
	cleanup.push(dir)
	return dir
}

function makeState(targetDirectory: string): OrchestrationState {
	return {
		userIntent: "test",
		targetDirectory,
		status: "EXECUTING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	} as OrchestrationState
}

function todayFolder(name: string): string {
	const today = new Date().toISOString().slice(0, 10)
	return `${today}-${name}`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sdd.create-feature — happy path with renderedTemplates", () => {
	it("creates 3 spec files with rendered content (not fallback stubs)", async () => {
		const dir = makeTempDir()
		const input: CreateFeatureInput = {
			name: "my-feature",
			description: "does stuff",
			renderedTemplates: {
				"plan.md": "# my-feature — Plan\n\nReal plan",
				"requirements.md": "Real reqs",
				"validation.md": "Real validation",
			},
		}
		const result = await step.execute(input, makeState(dir))

		expect(result.success).toBe(true)
		const folder = todayFolder("my-feature")
		expect(existsSync(join(dir, "specs", folder, "plan.md"))).toBe(true)
		expect(existsSync(join(dir, "specs", folder, "requirements.md"))).toBe(true)
		expect(existsSync(join(dir, "specs", folder, "validation.md"))).toBe(true)

		expect(readFileSync(join(dir, "specs", folder, "plan.md"), "utf-8")).toBe("# my-feature — Plan\n\nReal plan")
		expect(readFileSync(join(dir, "specs", folder, "requirements.md"), "utf-8")).toBe("Real reqs")
		expect(readFileSync(join(dir, "specs", folder, "validation.md"), "utf-8")).toBe("Real validation")
	})
})

describe("sdd.create-feature — kebab-case validation", () => {
	it("rejects non-kebab-case name with kebab-case in error", async () => {
		const dir = makeTempDir()
		const input: CreateFeatureInput = {
			name: "Bad Name!",
			description: "does stuff",
		}
		const result = await step.execute(input, makeState(dir))

		expect(result.success).toBe(false)
		expect(result.error).toContain("kebab-case")
	})
})

describe("sdd.create-feature — fallback path", () => {
	it("creates 3 spec files with fallback stubs when no renderedTemplates", async () => {
		const dir = makeTempDir()
		const input: CreateFeatureInput = {
			name: "my-feature",
			description: "does stuff",
		}
		const result = await step.execute(input, makeState(dir))

		expect(result.success).toBe(true)
		const folder = todayFolder("my-feature")
		const plan = readFileSync(join(dir, "specs", folder, "plan.md"), "utf-8")
		const reqs = readFileSync(join(dir, "specs", folder, "requirements.md"), "utf-8")
		const validation = readFileSync(join(dir, "specs", folder, "validation.md"), "utf-8")

		expect(plan).toContain("Plan")
		expect(reqs).toContain("Requirements")
		expect(validation).toContain("Validation")
	})
})

describe("sdd.create-feature — compensation", () => {
	it("removes all created files AND the feature folder", async () => {
		const dir = makeTempDir()
		const input: CreateFeatureInput = {
			name: "my-feature",
			description: "does stuff",
			renderedTemplates: {
				"plan.md": "real plan",
				"requirements.md": "real reqs",
				"validation.md": "real validation",
			},
		}
		const result = await step.execute(input, makeState(dir))
		expect(result.success).toBe(true)

		const data = result.compensationData as CreateFeatureCompensationData
		expect(data.createdFiles.length).toBe(3)

		await step.compensate(data, makeState(dir))

		for (const file of data.createdFiles) {
			expect(existsSync(file), `file should be removed: ${file}`).toBe(false)
		}
		expect(existsSync(data.featureFolder), "feature folder should be removed").toBe(false)
	})
})
