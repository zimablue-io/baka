// ---------------------------------------------------------------------------
// Unit tests for the prompt functions. We mock the `input` function
// (inquirer) and the E2E source so the prompt functions can be tested
// in isolation. These tests target the user-visible behavior: what
// the prompt functions print + what decisions they return.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { DesignSessionState } from "@repo/module-management-workflow"
import { createInitialState } from "@repo/module-management-workflow"
import { createE2EInputSource, resetDefaultE2EInputSource } from "./e2e-input"
import {
	promptDefineApproval,
	promptDeliverApproval,
	promptDevelopApproval,
	promptUser,
	resetHelpShown,
	type InputFn,
	type PromptDeps,
} from "./prompts"

function freshState(brief: string): DesignSessionState {
	return createInitialState({ moduleName: "x", brief })
}

function makeDeps(args: {
	answers?: string[]
	input?: InputFn
	showHelp?: boolean
}): PromptDeps {
	return {
		input: args.input ?? (vi.fn(async () => "ok") as unknown as InputFn),
		e2eSource: createE2EInputSource(""),
		shouldShowHelp: () => args.showHelp ?? false,
		markHelpShown: vi.fn(),
	}
}

beforeEach(() => {
	resetHelpShown()
	resetDefaultE2EInputSource()
})
afterEach(() => {
	resetHelpShown()
	resetDefaultE2EInputSource()
})

describe("promptUser — the user always sees context before typing", () => {
	test("prints the phase, brief, and (on first prompt) the slash command help", async () => {
		const log: string[] = []
		const origLog = console.log
		console.log = (msg: string) => log.push(msg)
		try {
			const deps: PromptDeps = {
				input: vi.fn(async () => "/exit") as unknown as InputFn,
				e2eSource: createE2EInputSource(""),
				shouldShowHelp: () => true,
				markHelpShown: vi.fn(),
			}
			await promptUser(freshState("build a SSOT for next.js v16"), deps)
		} finally {
			console.log = origLog
		}
		const combined = log.join("\n")
		expect(combined).toContain("[phase: DISCOVER]")
		expect(combined).toContain("[brief: build a SSOT for next.js v16")
		expect(combined).toContain("/exit")
	})

	test("the inquirer input function is called with a > prompt", async () => {
		const inputFn = vi.fn(async () => "/exit")
		await promptUser(freshState("b"), {
			input: inputFn as unknown as InputFn,
			e2eSource: createE2EInputSource(""),
			shouldShowHelp: () => false,
			markHelpShown: vi.fn(),
		})
		expect(inputFn).toHaveBeenCalledTimes(1)
		const call = (inputFn.mock.calls[0] as unknown as [{ message: string }] | undefined)?.[0]
		expect(call?.message).toBe("> ")
	})

	test("returns the user's typed text", async () => {
		const text = await promptUser(freshState("b"), makeDeps({ input: vi.fn(async () => "yes please") }))
		expect(text).toBe("yes please")
	})

	test("inquirer force-closed (ExitPromptError) returns null, not a throw", async () => {
		const inputFn = vi.fn(async () => {
			const err = new Error("User force closed the prompt")
			err.name = "ExitPromptError"
			throw err
		}) as unknown as InputFn
		const text = await promptUser(freshState("b"), {
			input: inputFn,
			e2eSource: createE2EInputSource(""),
			shouldShowHelp: () => false,
			markHelpShown: vi.fn(),
		})
		expect(text).toBeNull()
	})

	test("re-throws errors that are not inquirer force-closed", async () => {
		const inputFn = vi.fn(async () => {
			throw new Error("some other error")
		}) as unknown as InputFn
		await expect(
			promptUser(freshState("b"), {
				input: inputFn,
				e2eSource: createE2EInputSource(""),
				shouldShowHelp: () => false,
				markHelpShown: vi.fn(),
			}),
		).rejects.toThrow("some other error")
	})

	test("in E2E mode: the response is taken from the e2e source, not from inquirer", async () => {
		// Use a tmp file with one response to drive the E2E source.
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const { join } = await import("node:path")
		const dir = mkdtempSync(join(tmpdir(), "baka-prompt-e2e-"))
		const file = join(dir, "responses.txt")
		writeFileSync(file, "yes please\n")
		try {
			const inputFn = vi.fn(async () => "should not be called")
			const deps: PromptDeps = {
				input: inputFn as unknown as InputFn,
				e2eSource: createE2EInputSource(file),
				shouldShowHelp: () => false,
				markHelpShown: vi.fn(),
			}
			// Set BAKA_E2E_INPUT so isE2EMode() returns true.
			process.env.BAKA_E2E_INPUT = file
			resetDefaultE2EInputSource()
			const text = await promptUser(freshState("b"), deps)
			expect(text).toBe("yes please")
			expect(inputFn).not.toHaveBeenCalled()
		} finally {
			rmSync(dir, { recursive: true, force: true })
			delete process.env.BAKA_E2E_INPUT
			resetDefaultE2EInputSource()
		}
	})
})

describe("promptDefineApproval — parses the answer and resumes", () => {
	test("approves on 'yes' and resumes with the typed note", async () => {
		const inputFn = vi.fn(async () => "yes")
		const resume = vi.fn()
		await promptDefineApproval(freshState("b"), resume, makeDeps({ input: inputFn }))
		expect(resume).toHaveBeenCalledWith({ approved: true, note: "yes" })
	})

	test("rejects on 'no <reason>' and resumes with the reason", async () => {
		const inputFn = vi.fn(async () => "no  rename it")
		const resume = vi.fn()
		await promptDefineApproval(freshState("b"), resume, makeDeps({ input: inputFn }))
		expect(resume).toHaveBeenCalledWith({ approved: false, note: "rename it" })
	})

	test("in E2E mode: reads the answer from the e2e source", async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const { join } = await import("node:path")
		const dir = mkdtempSync(join(tmpdir(), "baka-prompt-e2e-"))
		const file = join(dir, "responses.txt")
		writeFileSync(file, "go\n")
		try {
			process.env.BAKA_E2E_INPUT = file
			resetDefaultE2EInputSource()
			const resume = vi.fn()
			await promptDefineApproval(freshState("b"), resume, {
				input: vi.fn() as unknown as InputFn,
				e2eSource: createE2EInputSource(file),
				shouldShowHelp: () => false,
				markHelpShown: vi.fn(),
			})
			expect(resume).toHaveBeenCalledWith({ approved: true, note: "go" })
		} finally {
			rmSync(dir, { recursive: true, force: true })
			delete process.env.BAKA_E2E_INPUT
			resetDefaultE2EInputSource()
		}
	})
})

describe("promptDevelopApproval — parses the answer and resumes", () => {
	test("approves on 'yes'", async () => {
		const inputFn = vi.fn(async () => "yes")
		const resume = vi.fn()
		await promptDevelopApproval(freshState("b"), resume, makeDeps({ input: inputFn }))
		expect(resume).toHaveBeenCalledWith({ approved: true })
	})

	test("rejects on 'edit <text>' and resumes with the edit", async () => {
		const inputFn = vi.fn(async () => "edit  drop the second param")
		const resume = vi.fn()
		await promptDevelopApproval(freshState("b"), resume, makeDeps({ input: inputFn }))
		expect(resume).toHaveBeenCalledWith({ approved: false, edits: "drop the second param" })
	})
})

describe("promptDeliverApproval — parses the answer and resumes", () => {
	test("approves on 'yes'", async () => {
		const inputFn = vi.fn(async () => "yes")
		const resume = vi.fn()
		await promptDeliverApproval(freshState("b"), resume, makeDeps({ input: inputFn }))
		expect(resume).toHaveBeenCalledWith({ approved: true })
	})

	test("rejects on 'no'", async () => {
		const inputFn = vi.fn(async () => "no")
		const resume = vi.fn()
		await promptDeliverApproval(freshState("b"), resume, makeDeps({ input: inputFn }))
		expect(resume).toHaveBeenCalledWith({ approved: false })
	})
})
