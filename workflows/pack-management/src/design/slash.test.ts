import { describe, expect, test, vi } from "vitest"
import type { ChatLoopHooks } from "./chat"
import { advanceOnSkip, handleSlashInLoop, statePackName } from "./slash"
import { createInitialState, setPhase, withHistory } from "./state"

// ---------------------------------------------------------------------------
// Slash command handling + phase-skip helpers. Tested in isolation so the
// chat loop tests don't have to cover every edge case.
// ---------------------------------------------------------------------------

function makeHooks(overrides: Partial<ChatLoopHooks> = {}): ChatLoopHooks {
	return {
		onAssistantMessage: vi.fn(),
		onUserInput: vi.fn(async () => null),
		runConsistency: vi.fn(async () => ({ passed: true, artifactDir: "", summary: "" })),
		...overrides,
	}
}

describe("handleSlashInLoop", () => {
	test("returns noop for non-slash input", async () => {
		const r = await handleSlashInLoop("hello", createInitialState({ packName: "x", brief: "b" }), makeHooks())
		expect(r.kind).toBe("noop")
	})

	test("/exit, /quit, /q all return kind=exit", async () => {
		for (const cmd of ["/exit", "/quit", "/q", "/EXIT", "/Quit"]) {
			const r = await handleSlashInLoop(cmd, createInitialState({ packName: "x", brief: "b" }), makeHooks())
			expect(r.kind).toBe("exit")
		}
	})

	test("/save, /show, /rewind, /undo, /validate, /help, /? all return kind=ok", async () => {
		for (const cmd of ["/save", "/show", "/rewind", "/undo", "/validate", "/help", "/?"]) {
			const r = await handleSlashInLoop(cmd, createInitialState({ packName: "x", brief: "b" }), makeHooks())
			expect(r.kind).toBe("ok")
		}
	})

	test("/back with no arg returns ok", async () => {
		const r = await handleSlashInLoop("/back", createInitialState({ packName: "x", brief: "b" }), makeHooks())
		expect(r.kind).toBe("ok")
	})

	test("/back with a valid phase returns phase-changed", async () => {
		for (const phase of ["DISCOVER", "DEFINE", "DEVELOP", "DELIVER"]) {
			const r = await handleSlashInLoop(
				`/back ${phase.toLowerCase()}`,
				createInitialState({ packName: "x", brief: "b" }),
				makeHooks(),
			)
			expect(r.kind).toBe("phase-changed")
			if (r.kind === "phase-changed") {
				expect(r.phase).toBe(phase)
			}
		}
	})

	test("/back with an invalid phase returns ok", async () => {
		const r = await handleSlashInLoop("/back garbage", createInitialState({ packName: "x", brief: "b" }), makeHooks())
		expect(r.kind).toBe("ok")
	})

	test("/skip returns kind=skip", async () => {
		const r = await handleSlashInLoop("/skip", createInitialState({ packName: "x", brief: "b" }), makeHooks())
		expect(r.kind).toBe("skip")
	})

	test("/consistency [n] [intent] calls hooks.runConsistency with parsed n and intent", async () => {
		const runConsistency = vi.fn(async () => ({ passed: true, artifactDir: "", summary: "ok" }))
		const state = withHistory(createInitialState({ packName: "x", brief: "b" }), { role: "user", content: "x" })
		state.designedRecipes = [
			{
				id: "scaffold",
				description: "S",
				params: [],
				requiresReasoning: false,
				compensatesWith: null,
				validators: [],
				testIntent: "scaffold intent",
			},
		]
		const r = await handleSlashInLoop("/consistency 3 custom intent text", state, makeHooks({ runConsistency }))
		expect(r.kind).toBe("consistency-result")
		expect(runConsistency).toHaveBeenCalledWith(3, "custom intent text")
	})

	test("/consistency with no n defaults to 5", async () => {
		const runConsistency = vi.fn(async () => ({ passed: true, artifactDir: "", summary: "ok" }))
		const state = createInitialState({ packName: "x", brief: "b" })
		await handleSlashInLoop("/consistency", state, makeHooks({ runConsistency }))
		expect(runConsistency).toHaveBeenCalledWith(5, `use x`)
	})

	test("/consistency with non-numeric n falls back to 5", async () => {
		const runConsistency = vi.fn(async () => ({ passed: true, artifactDir: "", summary: "ok" }))
		const state = createInitialState({ packName: "x", brief: "b" })
		await handleSlashInLoop("/consistency abc", state, makeHooks({ runConsistency }))
		expect(runConsistency).toHaveBeenCalledWith(5, "use x")
	})

	test("unknown slash command returns ok", async () => {
		const r = await handleSlashInLoop("/foobar", createInitialState({ packName: "x", brief: "b" }), makeHooks())
		expect(r.kind).toBe("ok")
	})
})

describe("advanceOnSkip", () => {
	test("DISCOVER -> DEFINE (and sets empty prefs)", () => {
		const s0 = createInitialState({ packName: "x", brief: "b" })
		const s1 = advanceOnSkip(s0)
		expect(s1.phase).toBe("DEFINE")
		expect(s1.prefs).toBe("")
	})

	test("DEFINE -> DEVELOP", () => {
		const s0 = setPhase(createInitialState({ packName: "x", brief: "b" }), "DEFINE")
		expect(advanceOnSkip(s0).phase).toBe("DEVELOP")
	})

	test("DEVELOP -> DELIVER", () => {
		const s0 = setPhase(createInitialState({ packName: "x", brief: "b" }), "DEVELOP")
		expect(advanceOnSkip(s0).phase).toBe("DELIVER")
	})

	test("DELIVER -> DONE", () => {
		const s0 = setPhase(createInitialState({ packName: "x", brief: "b" }), "DELIVER")
		expect(advanceOnSkip(s0).phase).toBe("DONE")
	})

	test("DONE is a no-op (returns same state)", () => {
		const s0 = setPhase(createInitialState({ packName: "x", brief: "b" }), "DONE")
		const s1 = advanceOnSkip(s0)
		expect(s1).toBe(s0)
	})
})

describe("statePackName", () => {
	test("extracts the last path component", () => {
		expect(statePackName("/foo/bar/baz")).toBe("baz")
		expect(statePackName("packs/my-mod")).toBe("my-mod")
	})

	test("falls back to 'pack' on an empty path", () => {
		expect(statePackName("")).toBe("pack")
		expect(statePackName("/")).toBe("pack")
	})
})
