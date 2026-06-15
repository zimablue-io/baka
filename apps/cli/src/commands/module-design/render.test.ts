// ---------------------------------------------------------------------------
// Unit tests for the pure rendering functions. These tests target the
// user-visible behavior: what the user sees on the screen must be
// deterministic given a state, and must include the context they need
// to know what to do next.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "vitest"
import type { DesignSessionState, DesignTurnPayload } from "@repo/module-management-workflow"
import {
	renderBriefEcho,
	renderConsistencyResult,
	renderDefineApprovalQuestion,
	renderDeliverApprovalQuestion,
	renderDevelopApprovalQuestion,
	renderFirstPromptContext,
	renderPayload,
	renderPhaseHeader,
	renderResumeContext,
	SLASH_HELP,
} from "./render"
import { createInitialState, setPhase, withHistory } from "@repo/module-management-workflow"

function freshState(brief: string): DesignSessionState {
	return createInitialState({ moduleName: "x", brief })
}

describe("renderBriefEcho", () => {
	test("wraps the brief in a labeled echo line", () => {
		expect(renderBriefEcho("a short brief")).toBe("[brief: a short brief]")
	})
})

describe("renderPhaseHeader", () => {
	test("labels the phase in brackets", () => {
		expect(renderPhaseHeader("DISCOVER")).toBe("[phase: DISCOVER]")
	})
})

describe("renderFirstPromptContext — the user always sees context before the first prompt", () => {
	test("shows the phase, brief, and slash command help on the very first prompt", () => {
		const out = renderFirstPromptContext(freshState("build me a thing"), { showHelp: true })
		expect(out).toContain("[phase: DISCOVER]")
		expect(out).toContain("[brief: build me a thing]")
		expect(out).toContain("/exit")
		expect(out).toContain("/show prefs")
		expect(out).toContain("/back")
	})

	test("truncates briefs over 100 characters with an ellipsis", () => {
		const long = "a".repeat(150)
		const out = renderFirstPromptContext(freshState(long), { showHelp: false })
		expect(out).toContain("[brief: " + "a".repeat(100) + "...]")
	})

	test("omits the brief echo when the brief is a synthetic placeholder (no leakage)", () => {
		// The workflow uses "__brief_*" markers internally; the prompt
		// must not echo them to the user.
		const out = renderFirstPromptContext(freshState("__brief_internal_marker"), { showHelp: false })
		expect(out).not.toContain("__brief_internal_marker")
	})

	test("omits the help block on the second-and-later prompts", () => {
		const out1 = renderFirstPromptContext(freshState("b"), { showHelp: true })
		const out2 = renderFirstPromptContext(freshState("b"), { showHelp: false })
		expect(out1).toContain("/exit")
		expect(out2).not.toContain("/exit")
	})
})

describe("renderResumeContext", () => {
	test("prints the last assistant message when there is one", () => {
		const s = withHistory(freshState("b"), { role: "assistant", content: "Hello from before." })
		expect(renderResumeContext(s)).toContain("Hello from before.")
	})

	test("returns an empty string when the last message is a user message (nothing to show)", () => {
		const s = withHistory(freshState("b"), { role: "user", content: "hi" })
		expect(renderResumeContext(s)).toBe("")
	})
})

describe("renderPayload — the LLM's response is rendered in a phase-appropriate shape", () => {
	test("DISCOVER: questions are rendered with id, prompt, and why", () => {
		const p: DesignTurnPayload = {
			phase: "DISCOVER",
			message: "Let me ask.",
			questions: [{ id: "domain", prompt: "What is the framework?", whyWeNeedThis: "framing" }],
			finished: false,
		}
		const out = renderPayload(p, freshState("b"))
		expect(out).toContain("Let me ask.")
		expect(out).toContain("Questions:")
		expect(out).toContain("[domain] What is the framework?")
		expect(out).toContain("why: framing")
	})

	test("DISCOVER finished: synthesizes PREFERENCES.md and shows no questions", () => {
		const p: DesignTurnPayload = {
			phase: "DISCOVER",
			message: "Got it.",
			questions: [],
			finished: true,
			synthesizedPrefs: "## Domain\nfoo",
		}
		const out = renderPayload(p, freshState("b"))
		expect(out).toContain("[LLM has synthesized PREFERENCES.md]")
		expect(out).not.toContain("Questions:")
	})

	test("DEFINE: action roster is rendered with id, description, rationale", () => {
		const p: DesignTurnPayload = {
			phase: "DEFINE",
			message: "Here's the roster.",
			actions: [{ id: "scaffold", description: "Scaffold a TS project", rationale: "baseline" }],
			finished: true,
		}
		const out = renderPayload(p, freshState("b"))
		expect(out).toContain("Proposed actions:")
		expect(out).toContain("- scaffold: Scaffold a TS project")
		expect(out).toContain("baseline")
	})

	test("DEVELOP: each action shows params, validators, requiresReasoning, testIntent", () => {
		const p: DesignTurnPayload = {
			phase: "DEVELOP",
			message: "Designed.",
			actions: [
				{
					id: "scaffold",
					params: [{ name: "name", type: "string", required: true, description: "the name" }],
					requiresReasoning: false,
					compensatesWith: null,
					validators: [{ id: "hasPackageJson", purpose: "must have package.json" }],
					testIntent: "scaffold a ts app",
				},
			],
			finished: true,
		}
		const out = renderPayload(p, freshState("b"))
		expect(out).toContain("scaffold:")
		expect(out).toContain("- name (string, required): the name")
		expect(out).toContain("requiresReasoning: false")
		expect(out).toContain("compensatesWith: (none)")
		expect(out).toContain("validators: hasPackageJson")
		expect(out).toContain('testIntent: "scaffold a ts app"')
	})

	test("DELIVER: just echoes the message in a labeled line", () => {
		const p: DesignTurnPayload = {
			phase: "DELIVER",
			message: "Ready to write files.",
			readmeSummary: "x",
			finished: true,
		}
		const out = renderPayload(p, freshState("b"))
		expect(out).toContain("[Ready to write files.]")
	})
})

describe("renderDefineApprovalQuestion — the user always sees the action roster before approving", () => {
	test("lists every action with id, description, and rationale", () => {
		const s = setPhase(freshState("b"), "DEFINE")
		s.roster = [
			{ id: "a1", description: "first action", rationale: "because" },
			{ id: "a2", description: "second action", rationale: "and also" },
		]
		const out = renderDefineApprovalQuestion(s)
		expect(out).toContain("[DEFINE] LLM proposed action roster:")
		expect(out).toContain("- a1: first action")
		expect(out).toContain("because")
		expect(out).toContain("- a2: second action")
	})

	test("renders an empty roster without throwing", () => {
		const out = renderDefineApprovalQuestion(setPhase(freshState("b"), "DEFINE"))
		expect(out).toContain("[DEFINE] LLM proposed action roster:")
	})
})

describe("renderDevelopApprovalQuestion — the user always sees the designed actions before approving", () => {
	test("lists every action with its param count, validator count, requiresReasoning, and testIntent", () => {
		const s = setPhase(freshState("b"), "DEVELOP")
		s.designedActions = [
			{
				id: "scaffold",
				description: "Scaffold",
				params: [{ name: "name", type: "string", required: true, description: "n" }],
				requiresReasoning: false,
				compensatesWith: null,
				validators: [{ id: "v1", purpose: "p" }],
				testIntent: "scaffold a ts app",
			},
		]
		const out = renderDevelopApprovalQuestion(s)
		expect(out).toContain("[DEVELOP] Designed action(s):")
		expect(out).toContain("scaffold: Scaffold")
		expect(out).toContain("params: 1, validators: 1, requiresReasoning=false")
		expect(out).toContain('testIntent: "scaffold a ts app"')
	})
})

describe("renderDeliverApprovalQuestion", () => {
	test("warns the user that file writes + consistency test are about to run", () => {
		expect(renderDeliverApprovalQuestion()).toMatch(/DELIVER.*write files.*consistency test/i)
	})
})

describe("renderConsistencyResult", () => {
	test("shows PASS or FAIL in the header with the run count", () => {
		const result = {
			passed: true,
			n: 5,
			moduleName: "x",
			actionId: "scaffold",
			artifactDir: "/tmp/art",
			perRun: [
				{ runIndex: 1, planActions: [], files: [], applyExitCode: 0 },
				{ runIndex: 2, planActions: [], files: [], applyExitCode: 0 },
			],
			divergences: [],
		}
		const out = renderConsistencyResult(result)
		expect(out).toContain("[consistency: PASS — 5 run(s) for x:scaffold]")
	})

	test("shows divergences up to a cap of 10 + a 'more' line", () => {
		const result = {
			passed: false,
			n: 5,
			moduleName: "x",
			actionId: "scaffold",
			artifactDir: "/tmp/art",
			perRun: [],
			divergences: Array.from({ length: 15 }, (_, i) => `divergence ${i + 1}`),
		}
		const out = renderConsistencyResult(result)
		expect(out).toContain("[consistency: FAIL")
		expect(out).toContain("divergence 1")
		expect(out).toContain("divergence 10")
		// Divergences past the cap are summarized, not listed individually.
		expect(out).not.toContain("divergence 11")
		expect(out).toContain("... (5 more)")
	})
})

describe("SLASH_HELP — the help block contains every command the REPL supports", () => {
	test("lists /exit, /save, /show prefs, /show actions, /show <id>, /rewind, /back, /skip, /consistency, /help", () => {
		for (const cmd of [
			"/exit",
			"/save",
			"/show prefs",
			"/show actions",
			"/show <id>",
			"/rewind",
			"/back <p>",
			"/skip",
			"/consistency",
			"/help",
		]) {
			expect(SLASH_HELP).toContain(cmd)
		}
	})
})
