import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, LLMRequest, LLMResponse } from "@repo/protocol"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { applyBack, applyPayload, loadSession, runChatLoop, runLLMTurn, saveSession } from "./chat"
import { defineApprovalHook, deliverApprovalHook, developApprovalHook } from "./hooks"
import type { DesignTurnPayload } from "./payload"
import { createInitialState, setPhase, withHistory } from "./state"

// ---------------------------------------------------------------------------
// Fake LLM provider. Returns the next payload from a script; the test
// controls the LLM's behaviour turn-by-turn. No real network, no real
// LLM, fully hermetic.
// ---------------------------------------------------------------------------

class FakeLLMProvider implements LLMProvider {
	readonly name = "fake"
	script: Array<DesignTurnPayload | { throw: Error }> = []
	calls: LLMRequest[] = []
	idx = 0
	validateConfig(): void {}
	async chat<T>(req: LLMRequest): Promise<LLMResponse<T>> {
		this.calls.push(req)
		const next = this.script[this.idx++]
		if (!next) throw new Error("fake: no more scripted responses")
		if ("throw" in next) throw next.throw
		return { content: next as unknown as T, usage: { promptTokens: 0, completionTokens: 0 }, raw: null }
	}
}

function makeDiscoverPayload(
	args: {
		questions?: Array<{ id: string; prompt: string; whyWeNeedThis: string }>
		finished?: boolean
		synthesizedPrefs?: string
	} = {},
): DesignTurnPayload {
	return {
		phase: "DISCOVER",
		message: "Let me learn about your domain.",
		questions: args.questions ?? [
			{ id: "domain", prompt: "What does this module cover?", whyWeNeedThis: "I need a framing." },
		],
		finished: args.finished ?? false,
		...(args.synthesizedPrefs ? { synthesizedPrefs: args.synthesizedPrefs } : {}),
	}
}

function makeDefinePayload(
	actions: Array<{ id: string; description: string; rationale: string }>,
	finished = false,
): DesignTurnPayload {
	return {
		phase: "DEFINE",
		message: "Here's my action roster.",
		actions,
		finished,
	}
}

function makeDevelopPayload(
	actions: Array<{
		id: string
		params: Array<{
			name: string
			type: "string" | "number" | "boolean" | "enum"
			required: boolean
			description: string
			enumValues?: string[]
		}>
		requiresReasoning: boolean
		compensatesWith: string | null
		validators: Array<{ id: string; purpose: string }>
		testIntent: string
	}>,
	finished = false,
): DesignTurnPayload {
	return {
		phase: "DEVELOP",
		message: "Designed all actions.",
		actions,
		finished,
	}
}

function makeDeliverPayload(): DesignTurnPayload {
	return {
		phase: "DELIVER",
		message: "Ready to deliver.",
		readmeSummary: "Auto-generated module.",
		finished: true,
	}
}

// ----- Session persistence (no LLM) --------------------------------------

describe("design session persistence", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-design-test-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		// Clean up any hooks that survived from a prior test.
		defineApprovalHook._clear()
		developApprovalHook._clear()
		deliverApprovalHook._clear()
	})

	test("loadSession returns null when no state file exists", () => {
		expect(loadSession(tmpDir)).toBeNull()
	})

	test("saveSession + loadSession roundtrip", () => {
		const state = withHistory(createInitialState({ moduleName: "test-mod", brief: "brief" }), {
			role: "user",
			content: "hello",
		})
		saveSession(state, tmpDir)
		expect(existsSync(join(tmpDir, ".design-state.json"))).toBe(true)
		const loaded = loadSession(tmpDir)
		expect(loaded).toEqual(state)
	})

	test("loadSession returns null for corrupted JSON", () => {
		const { writeFileSync } = require("node:fs") as typeof import("node:fs")
		writeFileSync(join(tmpDir, ".design-state.json"), "{not json")
		expect(loadSession(tmpDir)).toBeNull()
	})
})

// ----- runLLMTurn (no state mutation) -------------------------------------

describe("runLLMTurn", () => {
	test("returns the LLM payload and the updated history", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [makeDiscoverPayload()]
		const state = withHistory(createInitialState({ moduleName: "x", brief: "b" }), {
			role: "user",
			content: "first user turn",
		})
		const r = await runLLMTurn({ provider, state })
		expect(r.ok).toBe(true)
		expect(r.payload?.phase).toBe("DISCOVER")
		// Updated history is the input + one assistant message
		expect(r.updatedHistory).toHaveLength(2)
		expect(r.updatedHistory?.[1]?.role).toBe("assistant")
	})

	test("returns ok=false on LLM error without mutating history", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [{ throw: new Error("network blew up") }]
		const state = createInitialState({ moduleName: "x", brief: "b" })
		const r = await runLLMTurn({ provider, state })
		expect(r.ok).toBe(false)
		expect(r.error).toContain("network blew up")
	})
})

// ----- applyPayload (pure state transitions) ------------------------------

describe("applyPayload state machine", () => {
	test("DISCOVER with finished: true and synthesizedPrefs transitions to DEFINE and persists prefs", () => {
		const s0 = createInitialState({ moduleName: "x", brief: "b" })
		const { state: s1 } = applyPayload(
			s0,
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "# Prefs\n## Domain\ntest" }),
		)
		expect(s1.phase).toBe("DEFINE")
		expect(s1.prefs).toContain("## Domain")
	})

	test("DISCOVER without finished does not change phase", () => {
		const s0 = createInitialState({ moduleName: "x", brief: "b" })
		const { state: s1 } = applyPayload(
			s0,
			makeDiscoverPayload({ questions: [{ id: "q", prompt: "p", whyWeNeedThis: "w" }] }),
		)
		expect(s1.phase).toBe("DISCOVER")
	})

	test("DEFINE with finished: true sets roster and transitions to DEVELOP", () => {
		const s0 = setPhase(createInitialState({ moduleName: "x", brief: "b" }), "DEFINE")
		const { state: s1 } = applyPayload(
			s0,
			makeDefinePayload([{ id: "scaffold", description: "Scaffold", rationale: "Yes" }], true),
		)
		expect(s1.phase).toBe("DEVELOP")
		expect(s1.roster).toEqual([{ id: "scaffold", description: "Scaffold", rationale: "Yes" }])
	})

	test("DEVELOP with finished: true sets designedActions and transitions to DELIVER", () => {
		const s0 = setPhase(createInitialState({ moduleName: "x", brief: "b" }), "DEVELOP")
		const { state: s1, result } = applyPayload(
			s0,
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [{ name: "name", type: "string", required: true, description: "n" }],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [{ id: "hasPackageJson", purpose: "must have package.json" }],
						testIntent: "scaffold a TS app",
					},
				],
				true,
			),
		)
		expect(result.phaseChanged).toBe(true)
		expect(s1.phase).toBe("DELIVER")
		expect(s1.designedActions?.[0]?.id).toBe("scaffold")
	})

	test("DEVELOP without finished sets designedActions but stays in DEVELOP", () => {
		const s0 = setPhase(createInitialState({ moduleName: "x", brief: "b" }), "DEVELOP")
		const { state: s1, result } = applyPayload(
			s0,
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: "scaffold",
					},
				],
				false,
			),
		)
		expect(result.phaseChanged).toBe(false)
		expect(s1.phase).toBe("DEVELOP")
		expect(s1.designedActions?.[0]?.id).toBe("scaffold")
	})

	test("DELIVER payload marks delivered but does not change phase itself", () => {
		const s0 = setPhase(createInitialState({ moduleName: "x", brief: "b" }), "DELIVER")
		const { result } = applyPayload(s0, makeDeliverPayload())
		expect(result.delivered).toBe(true)
	})
})

// ----- applyBack ----------------------------------------------------------

describe("applyBack", () => {
	test("jumps to any phase", () => {
		const s0 = setPhase(createInitialState({ moduleName: "x", brief: "b" }), "DELIVER")
		expect(applyBack(s0, "DISCOVER").phase).toBe("DISCOVER")
		expect(applyBack(s0, "DEFINE").phase).toBe("DEFINE")
		expect(applyBack(s0, "DEVELOP").phase).toBe("DEVELOP")
	})
})

// ----- runChatLoop (the full flow with a scripted LLM) -------------------

describe("runChatLoop — the full double-diamond flow", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-design-chat-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		// Clean up any hooks that survived from a prior test.
		defineApprovalHook._clear()
		developApprovalHook._clear()
		deliverApprovalHook._clear()
	})

	test("DISCOVER -> DEFINE -> DEVELOP -> DELIVER -> DONE, consistency passes", async () => {
		const provider = new FakeLLMProvider()
		// The LLM drives DISCOVER -> DEFINE -> DEVELOP; the DEVELOP payload
		// with finished=true moves us to DELIVER (we don't need a separate
		// DELIVER payload from the LLM).
		provider.script = [
			// Bootstrap: the brief is injected as a synthetic first user
			// message; the LLM responds with the first DISCOVER questions.
			makeDiscoverPayload({ questions: [{ id: "domain", prompt: "What?", whyWeNeedThis: "Framing" }] }),
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "## Domain\nfoo" }),
			makeDefinePayload([{ id: "scaffold", description: "Scaffold", rationale: "Yes" }], true),
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [{ name: "name", type: "string", required: true, description: "n" }],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: "scaffold a ts app",
					},
				],
				true,
			),
		]
		// 3 user turns: the first is the answer to the bootstrap LLM's
		// question, then 2 nudges.
		const userInputs = ["answer 1", "looks good", "ship it"]
		const onAssistantMessage = vi.fn()
		const onStateChanged = vi.fn()
		const runConsistency = vi.fn(async () => ({ passed: true, artifactDir: "/tmp/x", summary: "pass" }))

		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage,
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onStateChanged,
				runConsistency,
			},
			brief: "build me a thing",
		})

		expect(result.exited).toBe("done")
		expect(result.finalState.phase).toBe("DONE")
		expect(result.finalState.prefs).toContain("## Domain")
		expect(result.finalState.roster?.[0]?.id).toBe("scaffold")
		expect(result.finalState.designedActions?.[0]?.id).toBe("scaffold")
		// The LLM was called 4 times: 1 bootstrap + 3 user-driven.
		expect(provider.calls).toHaveLength(4)
		// The assistant message was rendered for every successful LLM turn.
		expect(onAssistantMessage).toHaveBeenCalledTimes(4)
		// runConsistency was called once for the DELIVER phase.
		expect(runConsistency).toHaveBeenCalledTimes(1)
		expect(runConsistency).toHaveBeenCalledWith(5, "scaffold a ts app")
		// The synthetic first user message in history is the brief.
		expect(result.finalState.history[0]).toEqual({ role: "user", content: "build me a thing" })
		// The first assistant message is the bootstrap response.
		expect(result.finalState.history[1]?.role).toBe("assistant")
	})

	test("/skip from DEVELOP still runs the deliver logic", async () => {
		const provider = new FakeLLMProvider()
		// /skip from DISCOVER -> DEFINE; LLM returns DEFINE finished -> DEVELOP;
		// LLM returns DEVELOP finished -> DELIVER (developApproval auto-approves);
		// runDeliver fires runConsistency.
		provider.script = [
			// Bootstrap: brief -> LLM -> DISCOVER questions (no transition).
			makeDiscoverPayload({ questions: [{ id: "q", prompt: "q", whyWeNeedThis: "w" }] }),
			// Turn 1's LLM call: DEFINE finished -> DEVELOP (defineApproval auto-approves).
			makeDefinePayload(
				[
					{
						id: "scaffold",
						description: "Scaffold",
						rationale: "Yes",
					},
				],
				true,
			),
			// Turn 2's LLM call: DEVELOP finished -> DELIVER (developApproval auto-approves, then DELIVER runs).
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: "scaffold a ts app",
					},
				],
				true,
			),
		]
		// 2 user turns (after the bootstrap). Each is just "go" to nudge the LLM.
		const userInputs = ["go", "go"]
		const runConsistency = vi.fn(async () => ({ passed: true, artifactDir: "", summary: "pass" }))

		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onStateChanged: vi.fn(),
				runConsistency,
			},
			brief: "b",
		})
		// DEVELOP -> DELIVER triggered runDeliver -> runConsistency.
		expect(runConsistency).toHaveBeenCalledTimes(1)
		expect(runConsistency).toHaveBeenCalledWith(5, "scaffold a ts app")
		// And the chat loop should have exited with "done" (consistency passed).
		expect(result.exited).toBe("done")
	})

	test("LLM error is handled: user message is popped, next turn retries", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [
			// Bootstrap: brief -> LLM throws. The synthetic user message
			// gets popped, the loop starts over with the user's typed
			// input on turn 1.
			{ throw: new Error("transient") },
			// Turn 1's LLM call (with the user's first typed input) succeeds.
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "## Domain\nok" }),
			makeDefinePayload([{ id: "scaffold", description: "S", rationale: "R" }], true),
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: "t",
					},
				],
				true,
			),
		]
		// The bootstrap failed silently, so the user types a fresh prompt
		// (3 typed user turns after the failed bootstrap).
		const userInputs = ["hi", "retry", "ok"]
		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(async () => ({ passed: true, artifactDir: "", summary: "" })),
			},
			brief: "brief",
		})
		expect(result.exited).toBe("done")
		// The typed user turns in history: "hi" + "retry" + "ok" = 3,
		// plus the auto-approval messages ("Roster approved", "Design
		// approved") that the workflow injects at the approval gates.
		const typed = result.finalState.history.filter(
			(m) => m.role === "user" && m.content !== "Roster approved: auto-approved." && m.content !== "Design approved.",
		)
		expect(typed).toHaveLength(3)
		// The first user message in history is "hi" (NOT the brief, which
		// was popped when the bootstrap LLM call failed).
		expect(result.finalState.history.find((m) => m.role === "user" && m.content === "hi")).toBeTruthy()
		expect(result.finalState.history.find((m) => m.content === "brief")).toBeFalsy()
	})

	test("consistency failure sends the chat back to DEVELOP", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "## Domain\nx" }),
			makeDefinePayload([{ id: "scaffold", description: "S", rationale: "R" }], true),
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: "t",
					},
				],
				true,
			),
		]
		const userInputs = ["x", "ok", "ok"]
		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(async () => ({ passed: false, artifactDir: "/tmp/y", summary: "fail" })),
			},
			brief: "b",
		})
		expect(result.exited).toBe("consistency-failure")
		expect(result.finalState.phase).toBe("DEVELOP")
	})

	test("/exit breaks the loop and persists the final state", async () => {
		const provider = new FakeLLMProvider()
		const onStateChanged = vi.fn()
		const userInputs = ["/exit"]
		// No brief passed -> the bootstrap doesn't fire. /exit is the
		// first and only interaction; the LLM is never called.
		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onStateChanged,
				runConsistency: vi.fn(),
			},
		})
		expect(result.exited).toBe("user-exit")
		expect(result.turns).toBe(1)
		// No LLM calls happened.
		expect(provider.calls).toHaveLength(0)
	})

	test("/skip advances through phases when LLM is unavailable", async () => {
		const provider = new FakeLLMProvider()
		// We start in DISCOVER; /skip -> DEFINE; /skip -> DEVELOP (no roster so
		// we need to set one first); /skip -> DELIVER. The chat will need an
		// LLM call for the DELIVER payload to write files + run consistency.
		provider.script = [makeDeliverPayload()]
		const userInputs = ["/skip", "/skip", "/skip", "/skip"]
		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(async () => ({ passed: true, artifactDir: "", summary: "pass" })),
			},
			brief: "b",
		})
		// Without a roster, the DELIVER phase has no actions, so the loop
		// transitions to DONE without writing files or running consistency.
		expect(result.exited).toBe("done")
	})

	test("resumes from a saved state file", async () => {
		// Pre-populate a state file with phase=DEFINE and one turn of history.
		const state = withHistory(setPhase(createInitialState({ moduleName: "x", brief: "b" }), "DEFINE"), {
			role: "user",
			content: "previous turn",
		})
		saveSession(state, tmpDir)
		// Resume the loop.
		const provider = new FakeLLMProvider()
		provider.script = [
			makeDefinePayload([{ id: "scaffold", description: "S", rationale: "R" }], true),
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: "t",
					},
				],
				true,
			),
			makeDeliverPayload(),
		]
		const userInputs = ["/skip", "/skip", "/skip"]
		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(async () => ({ passed: true, artifactDir: "", summary: "pass" })),
			},
		})
		expect(result.exited).toBe("done")
		// The previous user turn is still in history.
		expect(result.finalState.history.find((m) => m.content === "previous turn")).toBeTruthy()
	})

	test("approval gate: onDefineApproval rejection rolls back to DEFINE and re-thinks", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [
			// Turn 1 LLM: DISCOVER finished (DISCOVER -> DEFINE)
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "## Domain\nx" }),
			// Turn 2 LLM: DEFINE finished, the user's first proposal (DEFINE -> DEVELOP)
			makeDefinePayload([{ id: "scaffold", description: "S", rationale: "R" }], true),
			// The user REJECTS this roster. The loop feeds "Roster rejected" back to the LLM.
			// Turn 3 LLM: DEFINE again, a new proposal (stays in DEFINE, not finished).
			makeDefinePayload([{ id: "scaffold", description: "S2", rationale: "R2" }], false),
			// Turn 4 LLM: DEFINE finished with the new proposal (DEFINE -> DEVELOP)
			makeDefinePayload([{ id: "scaffold", description: "S3", rationale: "R3" }], true),
			// Turn 5 LLM: DEVELOP finished (DEVELOP -> DELIVER, then deliver runs)
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: "t",
					},
				],
				true,
			),
		]
		const userInputs = ["x", "ok", "ok", "ok", "ok"]
		let approvalCalls = 0
		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onDefineApproval: (_state, resume) => {
					approvalCalls++
					if (approvalCalls === 1) {
						// First roster: reject with a note.
						resume({ approved: false, note: "rename to scaffold2" })
					} else {
						// Second roster: approve.
						resume({ approved: true })
					}
				},
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(async () => ({ passed: true, artifactDir: "", summary: "pass" })),
			},
			brief: "b",
		})
		expect(result.exited).toBe("done")
		expect(approvalCalls).toBe(2)
		// The rejection note was fed back to the LLM as a user message.
		const rejection = result.finalState.history.find(
			(m) => m.role === "user" && m.content.includes("Roster rejected: rename to scaffold2"),
		)
		expect(rejection).toBeTruthy()
	})

	test("approval gate: onDeliverApproval rejection rolls back to DEVELOP", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "## Domain\nx" }),
			makeDefinePayload([{ id: "scaffold", description: "S", rationale: "R" }], true),
			makeDevelopPayload(
				[
					{
						id: "scaffold",
						params: [],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: "t",
					},
				],
				true,
			),
		]
		const userInputs = ["x", "ok", "ok"]
		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => userInputs[i++] ?? null
				})(),
				onDefineApproval: (_state, resume) => resume({ approved: true }),
				onDevelopApproval: (_state, resume) => resume({ approved: true }),
				onDeliverApproval: (_state, resume) => resume({ approved: false }),
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(),
			},
			brief: "b",
		})
		expect(result.exited).toBe("rejected")
		expect(result.finalState.phase).toBe("DEVELOP")
		// Consistency was NOT called because the user rejected before the
		// file write.
		expect(provider.calls).toHaveLength(3)
	})
})

// ----- Fresh-session behavior (user-visible promises) ---------------------
//
// These tests would have caught the bug where the chat loop's first
// action was to call hooks.onUserInput, leaving the user staring at a
// bare `> ` with no idea what to do. They describe the user-visible
// BEHAVIOR the system promises — not the implementation that makes it
// happen — so any future refactor that breaks the promise will fail
// these tests too.

describe("runChatLoop — the user always sees the LLM's first response before being asked to type", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-design-fresh-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		defineApprovalHook._clear()
		developApprovalHook._clear()
		deliverApprovalHook._clear()
	})

	test("the assistant's first message is rendered BEFORE the first user input is requested", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [
			makeDiscoverPayload({ questions: [{ id: "domain", prompt: "Domain?", whyWeNeedThis: "Framing" }] }),
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "## Domain\nfoo" }),
		]
		const callOrder: string[] = []
		const onAssistantMessage = vi.fn(() => callOrder.push("assistant"))
		const onUserInput = vi.fn(async () => {
			callOrder.push("user")
			return "/exit"
		})
		await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage,
				onUserInput,
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(),
			},
			brief: "build a next.js module",
		})
		// The first call is the assistant (bootstrap response), THEN the
		// user. Before the fix, the first call was the user with no
		// assistant message in between.
		expect(callOrder[0]).toBe("assistant")
		expect(callOrder[1]).toBe("user")
	})

	test("the LLM is always called with the brief as the first user message on a fresh session", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [makeDiscoverPayload({ questions: [{ id: "q", prompt: "q", whyWeNeedThis: "w" }] })]
		await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: async () => "/exit",
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(),
			},
			brief: "my specific brief text",
		})
		// The LLM was called with the brief as the most recent user message.
		const lastCall = provider.calls[0]
		const lastUser = [...(lastCall?.messages ?? [])].reverse().find((m) => m.role === "user")
		expect(lastUser?.content).toBe("my specific brief text")
	})

	test("on a resumed session, the bootstrap does not fire (no duplicate LLM call)", async () => {
		// Pre-populate a state file with phase=DEFINE and a turn of history.
		const state = withHistory(setPhase(createInitialState({ moduleName: "x", brief: "old brief" }), "DEFINE"), {
			role: "user",
			content: "previous turn",
		})
		saveSession(state, tmpDir)
		const provider = new FakeLLMProvider()
		provider.script = [makeDefinePayload([{ id: "scaffold", description: "S", rationale: "R" }], true)]
		const callOrder: string[] = []
		await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(() => callOrder.push("assistant")),
				onUserInput: (() => {
					let i = 0
					return async () => {
						callOrder.push("user")
						return ["go", "/exit"][i++] ?? null
					}
				})(),
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(),
			},
			brief: "new brief should be ignored on resume",
		})
		// The LLM is called once (for the user's typed "go"). There is NO
		// bootstrap call — the resume case skips the bootstrap because
		// state.history already has content.
		expect(provider.calls).toHaveLength(1)
		// First call is the user (no assistant message before that, since
		// there's no bootstrap on resume).
		expect(callOrder[0]).toBe("user")
	})

	test("if the bootstrap LLM call fails, the user can still type and the LLM is called again", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [
			// Bootstrap fails.
			{ throw: new Error("model down") },
			// First user-driven LLM call succeeds.
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "## Domain\nok" }),
		]
		const result = await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => ["go", "/exit"][i++] ?? null
				})(),
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(),
			},
			brief: "my brief",
		})
		// The synthetic user message "my brief" was popped from history.
		const syntheticUser = result.finalState.history.find((m) => m.role === "user" && m.content === "my brief")
		expect(syntheticUser).toBeFalsy()
		// The bootstrap LLM error did NOT abort the loop — the user's
		// "go" was processed and the LLM was called again successfully.
		expect(result.exited).toBe("user-exit")
		// 2 LLM calls total: 1 failed bootstrap + 1 successful user-driven.
		expect(provider.calls).toHaveLength(2)
	})

	test("if the bootstrap LLM call fails, the CLI is notified via onBootstrapFailed so it can surface a clear error", async () => {
		const provider = new FakeLLMProvider()
		provider.script = [
			{ throw: new Error("model down") },
			makeDiscoverPayload({ finished: true, synthesizedPrefs: "## Domain\nok" }),
		]
		const onBootstrapFailed = vi.fn()
		await runChatLoop({
			provider,
			moduleDir: tmpDir,
			hooks: {
				onAssistantMessage: vi.fn(),
				onUserInput: (() => {
					let i = 0
					return async () => ["go", "/exit"][i++] ?? null
				})(),
				onStateChanged: vi.fn(),
				runConsistency: vi.fn(),
				onBootstrapFailed,
			},
			brief: "my brief",
		})
		// The CLI was notified of the bootstrap failure so it can print
		// an error instead of leaving the user staring at a bare prompt.
		expect(onBootstrapFailed).toHaveBeenCalledTimes(1)
		expect(onBootstrapFailed.mock.calls[0]?.[0]).toMatch(/model down/i)
	})
})

// ----- writeModuleFiles (real disk) ---------------------------------------

describe("writeModuleFiles", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-design-write-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		// Clean up any hooks that survived from a prior test.
		defineApprovalHook._clear()
		developApprovalHook._clear()
		deliverApprovalHook._clear()
	})

	test("writes manifest, action.ts, validators, package.json, tsconfig, README", async () => {
		const { writeModuleFiles } = await import("./render/index.js" as string)
		const state = setPhase(createInitialState({ moduleName: "test-mod", brief: "test" }), "DELIVER")
		state.prefs = "## Domain\nfoo"
		state.designedActions = [
			{
				id: "scaffold",
				description: "Scaffold a TS project",
				params: [{ name: "name", type: "string", required: true, description: "name" }],
				requiresReasoning: false,
				compensatesWith: null,
				validators: [{ id: "hasPackageJson", purpose: "must have package.json" }],
				testIntent: "scaffold",
			},
		]
		const { writtenFiles } = writeModuleFiles({
			moduleDir: tmpDir,
			moduleName: "test-mod",
			state,
		})
		expect(writtenFiles.length).toBeGreaterThan(0)
		expect(existsSync(join(tmpDir, "manifest.ts"))).toBe(true)
		expect(existsSync(join(tmpDir, "scaffold/action.ts"))).toBe(true)
		expect(existsSync(join(tmpDir, "scaffold/validators/hasPackageJson.ts"))).toBe(true)
		expect(existsSync(join(tmpDir, "package.json"))).toBe(true)
		expect(existsSync(join(tmpDir, "tsconfig.json"))).toBe(true)
		expect(existsSync(join(tmpDir, "README.md"))).toBe(true)
		expect(existsSync(join(tmpDir, "PREFERENCES.md"))).toBe(true)

		// Spot-check the manifest content
		const manifest = readFileSync(join(tmpDir, "manifest.ts"), "utf-8")
		expect(manifest).toContain('"name": "test-mod"')
		expect(manifest).toContain('"scaffold"')
		expect(manifest).toContain("baka-sdk")

		// Spot-check the action stub
		const action = readFileSync(join(tmpDir, "scaffold/action.ts"), "utf-8")
		expect(action).toContain("export const scaffold: ActionFn")
		expect(action).toContain("export const compensate: CompensationFn")
	})

	test("writes templates only when requiresReasoning is true", async () => {
		const { writeModuleFiles } = await import("./render/index.js" as string)
		const state = setPhase(createInitialState({ moduleName: "tmpl-mod", brief: "x" }), "DELIVER")
		state.designedActions = [
			{
				id: "reason",
				description: "reasoning action",
				params: [],
				requiresReasoning: true,
				compensatesWith: null,
				validators: [],
				templates: [{ id: "outline", outline: "say hi to {{name}}" }],
				testIntent: "t",
			},
		]
		writeModuleFiles({ moduleDir: tmpDir, moduleName: "tmpl-mod", state })
		expect(existsSync(join(tmpDir, "reason/templates/outline.hbs"))).toBe(true)
	})
})
