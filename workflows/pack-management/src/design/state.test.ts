import { describe, expect, test } from "vitest"
import {
	applySlashCommand,
	createInitialState,
	invalidPackNameMessage,
	isValidPackName,
	rewindLastTurn,
	setPhase,
	touch,
	withHistory,
} from "./state"

describe("pack name validation", () => {
	test("accepts simple lowercase names", () => {
		expect(isValidPackName("foo")).toBe(true)
		expect(isValidPackName("my-mod")).toBe(true)
		expect(isValidPackName("mod_v2")).toBe(true)
	})

	test("accepts dotted names (next.js, foo.bar.baz)", () => {
		expect(isValidPackName("next.js")).toBe(true)
		expect(isValidPackName("foo.bar.baz")).toBe(true)
	})

	test("rejects names with uppercase", () => {
		expect(isValidPackName("Foo")).toBe(false)
		expect(isValidPackName("myMod")).toBe(false)
	})

	test("rejects names with spaces or slashes", () => {
		expect(isValidPackName("my mod")).toBe(false)
		expect(isValidPackName("my/mod")).toBe(false)
		expect(isValidPackName("")).toBe(false)
	})

	test("rejects names longer than 64 chars", () => {
		expect(isValidPackName("a".repeat(65))).toBe(false)
		expect(isValidPackName("a".repeat(64))).toBe(true)
	})

	test("invalidPackNameMessage is human-readable", () => {
		expect(invalidPackNameMessage()).toMatch(/lowercase/)
	})
})

describe("state factory", () => {
	test("createInitialState sets phase=DISCOVER and empty history", () => {
		const s = createInitialState({ packName: "foo", brief: "test brief" })
		expect(s.phase).toBe("DISCOVER")
		expect(s.packName).toBe("foo")
		expect(s.brief).toBe("test brief")
		expect(s.history).toEqual([])
		expect(s.prefs).toBeUndefined()
		expect(s.roster).toBeUndefined()
		expect(s.designedRecipes).toBeUndefined()
	})

	test("touch updates the updatedAt timestamp", () => {
		const s0 = createInitialState({ packName: "foo", brief: "x", now: "2020-01-01T00:00:00Z" })
		const s1 = touch(s0, "2026-01-01T00:00:00Z")
		expect(s1.updatedAt).toBe("2026-01-01T00:00:00Z")
		expect(s1.createdAt).toBe("2020-01-01T00:00:00Z")
	})

	test("withHistory appends a message", () => {
		const s0 = createInitialState({ packName: "foo", brief: "x" })
		const s1 = withHistory(s0, { role: "user", content: "hi" })
		expect(s1.history).toHaveLength(1)
		expect(s1.history[0]).toEqual({ role: "user", content: "hi" })
	})

	test("setPhase changes the phase", () => {
		const s0 = createInitialState({ packName: "foo", brief: "x" })
		const s1 = setPhase(s0, "DEVELOP")
		expect(s1.phase).toBe("DEVELOP")
	})

	test("rewindLastTurn pops a user+assistant pair", () => {
		const s0 = createInitialState({ packName: "foo", brief: "x" })
		const s1 = withHistory(s0, { role: "user", content: "u1" })
		const s2 = withHistory(s1, { role: "assistant", content: "a1" })
		const s3 = withHistory(s2, { role: "user", content: "u2" })
		const s4 = withHistory(s3, { role: "assistant", content: "a2" })
		const rewound = rewindLastTurn(s4)
		expect(rewound.history).toEqual(s2.history)
	})

	test("rewindLastTurn does nothing when there are fewer than 2 messages", () => {
		const s0 = createInitialState({ packName: "foo", brief: "x" })
		const s1 = withHistory(s0, { role: "user", content: "u1" })
		const rewound = rewindLastTurn(s1)
		expect(rewound.history).toEqual(s1.history)
	})
})

describe("slash command dispatch", () => {
	const baseState = () => createInitialState({ packName: "test-mod", brief: "build me a thing" })

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

	test("/show recipes -> show-recipes", () => {
		expect(applySlashCommand("/show recipes", baseState()).kind).toBe("show-recipes")
	})

	test("/show <id> -> show-recipe", () => {
		const r = applySlashCommand("/show scaffold", baseState())
		expect(r.kind).toBe("show-recipe")
		if (r.kind === "show-recipe") expect(r.id).toBe("scaffold")
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
