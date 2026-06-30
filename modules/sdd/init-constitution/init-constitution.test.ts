import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestrationState } from "baka-sdk"
import { afterEach, describe, expect, it } from "vitest"
import step, { type InitConstitutionCompensationData, type InitConstitutionInput } from "./action.js"

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
	const dir = mkdtempSync(join(tmpdir(), "baka-sdd-init-"))
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sdd.init-constitution — happy path with renderedTemplates", () => {
	it("creates 3 spec files with rendered content (not fallback stubs)", async () => {
		const dir = makeTempDir()
		const input: InitConstitutionInput = {
			productName: "TestApp",
			summary: "A test app",
			renderedTemplates: {
				"mission.md": "# TestApp — Mission\n\nReal content",
				"tech-stack.md": "# TestApp — Tech Stack\n\nReal stack",
				"roadmap.md": "# TestApp — Roadmap\n\nReal roadmap",
			},
		}
		const result = await step.execute(input, makeState(dir))

		expect(result.success).toBe(true)
		expect(existsSync(join(dir, "specs", "mission.md"))).toBe(true)
		expect(existsSync(join(dir, "specs", "tech-stack.md"))).toBe(true)
		expect(existsSync(join(dir, "specs", "roadmap.md"))).toBe(true)

		expect(readFileSync(join(dir, "specs", "mission.md"), "utf-8")).toBe("# TestApp — Mission\n\nReal content")
		expect(readFileSync(join(dir, "specs", "tech-stack.md"), "utf-8")).toBe("# TestApp — Tech Stack\n\nReal stack")
		expect(readFileSync(join(dir, "specs", "roadmap.md"), "utf-8")).toBe("# TestApp — Roadmap\n\nReal roadmap")
	})
})

describe("sdd.init-constitution — fallback path", () => {
	it("creates 3 spec files with fallback stubs when no renderedTemplates", async () => {
		const dir = makeTempDir()
		const input: InitConstitutionInput = {
			productName: "TestApp",
			summary: "A test app",
		}
		const result = await step.execute(input, makeState(dir))

		expect(result.success).toBe(true)
		const mission = readFileSync(join(dir, "specs", "mission.md"), "utf-8")
		const techStack = readFileSync(join(dir, "specs", "tech-stack.md"), "utf-8")
		const roadmap = readFileSync(join(dir, "specs", "roadmap.md"), "utf-8")

		// Fallback content includes the heading and the summary/TBD body.
		expect(mission).toContain("Mission")
		expect(mission).toContain("A test app")
		expect(techStack).toContain("Tech Stack")
		expect(roadmap).toContain("Roadmap")
	})
})

describe("sdd.init-constitution — compensation", () => {
	it("removes all 3 created files", async () => {
		const dir = makeTempDir()
		const input: InitConstitutionInput = {
			productName: "TestApp",
			summary: "A test app",
			renderedTemplates: {
				"mission.md": "real mission",
				"tech-stack.md": "real stack",
				"roadmap.md": "real roadmap",
			},
		}
		const result = await step.execute(input, makeState(dir))
		expect(result.success).toBe(true)

		const data = result.compensationData as InitConstitutionCompensationData
		expect(data.createdFiles.length).toBe(3)

		await step.compensate(data, makeState(dir))

		for (const file of data.createdFiles) {
			expect(existsSync(file), `file should be removed: ${file}`).toBe(false)
		}
	})
})

describe("sdd.init-constitution — input validation", () => {
	it("missing productName returns success:false with productName in error", async () => {
		const dir = makeTempDir()
		const input = { summary: "A test app" } as InitConstitutionInput
		const result = await step.execute(input, makeState(dir))

		expect(result.success).toBe(false)
		expect(result.error).toContain("productName")
	})

	it("missing summary returns success:false with summary in error", async () => {
		const dir = makeTempDir()
		const input = { productName: "TestApp" } as InitConstitutionInput
		const result = await step.execute(input, makeState(dir))

		expect(result.success).toBe(false)
		expect(result.error).toContain("summary")
	})
})
