import { describe, expect, test } from "vitest"
import {
	applySlashCommand,
	createInitialState,
	invalidModuleNameMessage,
	isValidModuleName,
	rewindLastTurn,
	setPhase,
	touch,
	withHistory,
} from "./state"

describe("module name validation", () => {
	test("accepts simple lowercase names", () => {
		expect(isValidModuleName("foo")).toBe(true)
		expect(isValidModuleName("my-mod")).toBe(true)
		expect(isValidModuleName("mod_v2")).toBe(true)
	})

	test("accepts dotted names (next.js, foo.bar.baz)", () => {
		expect(isValidModuleName("next.js")).toBe(true)
		expect(isValidModuleName("foo.bar.baz")).toBe(true)
	})

	test("rejects names with uppercase", () => {
		expect(isValidModuleName("Foo")).toBe(false)
		expect(isValidModuleName("myMod")).toBe(false)
	})

	test("rejects names with spaces or slashes", () => {
		expect(isValidModuleName("my mod")).toBe(false)
		expect(isValidModuleName("my/mod")).toBe(false)
		expect(isValidModuleName("")).toBe(false)
	})

	test("rejects names longer than 64 chars", () => {
		expect(isValidModuleName("a".repeat(65))).toBe(false)
		expect(isValidModuleName("a".repeat(64))).toBe(true)
	})

	test("invalidModuleNameMessage is human-readable", () => {
		expect(invalidModuleNameMessage()).toMatch(/lowercase/)
	})
})

describe("state factory", () => {
	test("createInitialState sets phase=DISCOVER and empty history", () => {
		const s = createInitialState({ moduleName: "foo", brief: "test brief" })
		expect(s.phase).toBe("DISCOVER")
		expect(s.moduleName).toBe("foo")
		expect(s.brief).toBe("test brief")
		expect(s.history).toEqual([])
		expect(s.prefs).toBeUndefined()
		expect(s.roster).toBeUndefined()
		expect(s.designedActions).toBeUndefined()
	})

	test("touch updates the updatedAt timestamp", () => {
		const s0 = createInitialState({ moduleName: "foo", brief: "x", now: "2020-01-01T00:00:00Z" })
		const s1 = touch(s0, "2026-01-01T00:00:00Z")
		expect(s1.updatedAt).toBe("2026-01-01T00:00:00Z")
		expect(s1.createdAt).toBe("2020-01-01T00:00:00Z")
	})

	test("withHistory appends a message", () => {
		const s0 = createInitialState({ moduleName: "foo", brief: "x" })
		const s1 = withHistory(s0, { role: "user", content: "hi" })
		expect(s1.history).toHaveLength(1)
		expect(s1.history[0]).toEqual({ role: "user", content: "hi" })
	})

	test("setPhase changes the phase", () => {
		const s0 = createInitialState({ moduleName: "foo", brief: "x" })
		const s1 = setPhase(s0, "DEVELOP")
		expect(s1.phase).toBe("DEVELOP")
	})

	test("rewindLastTurn pops a user+assistant pair", () => {
		const s0 = createInitialState({ moduleName: "foo", brief: "x" })
		const s1 = withHistory(s0, { role: "user", content: "u1" })
		const s2 = withHistory(s1, { role: "assistant", content: "a1" })
		const s3 = withHistory(s2, { role: "user", content: "u2" })
		const s4 = withHistory(s3, { role: "assistant", content: "a2" })
		const rewound = rewindLastTurn(s4)
		expect(rewound.history).toEqual(s2.history)
	})

	test("rewindLastTurn does nothing when there are fewer than 2 messages", () => {
		const s0 = createInitialState({ moduleName: "foo", brief: "x" })
		const s1 = withHistory(s0, { role: "user", content: "u1" })
		const rewound = rewindLastTurn(s1)
		expect(rewound.history).toEqual(s1.history)
	})
})

describe("slash command dispatch", () => {
	const baseState = () => createInitialState({ moduleName: "test-mod", brief: "build me a thing" })

	test("/exit is recognized", () => {
		const r = applySlashCommand("/exit", baseState())
		expect(r.kind).toBe("exit")
	})

	test("/q and /quit are aliases for /exit", () => {
		expect(applySlashCommand("/q", baseState()).kind).toBe("exit")
		expect(applySlashCommand("/quit", baseState()).kind).toBe("exit")
	})

	test("/save returns ok", () => {
		const r = applySlashCommand("/save", baseState())
		expect(r.kind).toBe("ok")
		if (r.kind === "ok") expect(r.message).toBe("saved")
	})

	test("/show prefs -> show-prefs", () => {
		expect(applySlashCommand("/show prefs", baseState()).kind).toBe("show-prefs")
	})

	test("/show actions -> show-actions", () => {
		expect(applySlashCommand("/show actions", baseState()).kind).toBe("show-actions")
	})

	test("/show <id> -> show-action", () => {
		const r = applySlashCommand("/show scaffold", baseState())
		expect(r.kind).toBe("show-action")
		if (r.kind === "show-action") expect(r.id).toBe("scaffold")
	})

	test("/show with no argument returns ok with usage", () => {
		const r = applySlashCommand("/show", baseState())
		expect(r.kind).toBe("ok")
		if (r.kind === "ok") expect(r.message).toContain("usage")
	})

	test("/rewind returns rewound when there are >= 2 messages", () => {
		const s = withHistory(withHistory(baseState(), { role: "user", content: "a" }), {
			role: "assistant",
			content: "b",
		})
		expect(applySlashCommand("/rewind", s).kind).toBe("rewound")
	})

	test("/rewind returns ok when there are < 2 messages", () => {
		const r = applySlashCommand("/rewind", baseState())
		expect(r.kind).toBe("ok")
		if (r.kind === "ok") expect(r.message).toBe("nothing to rewind")
	})

	test("/back <phase> returns back", () => {
		expect(applySlashCommand("/back DISCOVER", baseState()).kind).toBe("back")
		expect(applySlashCommand("/back DEFINE", baseState()).kind).toBe("back")
		expect(applySlashCommand("/back DEVELOP", baseState()).kind).toBe("back")
		expect(applySlashCommand("/back DELIVER", baseState()).kind).toBe("back")
	})

	test("/back with bad phase returns ok with usage", () => {
		const r = applySlashCommand("/back NOPE", baseState())
		expect(r.kind).toBe("ok")
		if (r.kind === "ok") expect(r.message).toContain("usage")
	})

	test("/skip returns skip", () => {
		expect(applySlashCommand("/skip", baseState()).kind).toBe("skip")
	})

	test("/consistency returns the parsed n and intent", () => {
		const r = applySlashCommand("/consistency 3 do the thing", baseState())
		expect(r.kind).toBe("consistency")
		if (r.kind === "consistency") {
			expect(r.n).toBe(3)
			expect(r.intent).toBe("do the thing")
		}
	})

	test("/consistency with no n defaults to 5", () => {
		const r = applySlashCommand("/consistency", baseState())
		expect(r.kind).toBe("consistency")
		if (r.kind === "consistency") {
			expect(r.n).toBe(5)
			expect(r.intent).toContain("use test-mod")
		}
	})

	test("/consistency with invalid n falls back to 5", () => {
		const r = applySlashCommand("/consistency abc", baseState())
		expect(r.kind).toBe("consistency")
		if (r.kind === "consistency") expect(r.n).toBe(5)
	})

	test("/help returns help", () => {
		expect(applySlashCommand("/help", baseState()).kind).toBe("help")
		expect(applySlashCommand("/?", baseState()).kind).toBe("help")
	})

	test("unknown command returns unknown with the cmd", () => {
		const r = applySlashCommand("/wat", baseState())
		expect(r.kind).toBe("unknown")
		if (r.kind === "unknown") expect(r.cmd).toBe("wat")
	})

	test("non-slash input is noop", () => {
		expect(applySlashCommand("hello world", baseState()).kind).toBe("noop")
	})
})
