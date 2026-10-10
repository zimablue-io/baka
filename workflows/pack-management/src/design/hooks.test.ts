import { afterEach, describe, expect, test } from "vitest"
import { z } from "zod"
import {
	defineApprovalHook,
	defineHook,
	deliverApprovalHook,
	developApprovalHook,
	userInputHook,
	zodSchema,
} from "./hooks"

// ---------------------------------------------------------------------------
// Local defineHook: matches the workflow-sdk API for HITL. These tests
// exercise the local implementation; if/when we move to a hosted UI, the
// real `workflow.defineHook` should pass the same tests.
// ---------------------------------------------------------------------------

describe("defineHook", () => {
	afterEach(() => {
		userInputHook._clear()
		defineApprovalHook._clear()
		developApprovalHook._clear()
		deliverApprovalHook._clear()
	})

	test("create + resume roundtrip: resolved value is the resume payload", async () => {
		const hook = defineHook<{ approved: boolean; note?: string }>()
		const promise = hook.create({ token: "tok-1" })
		expect(promise.token).toBe("tok-1")
		hook.resume("tok-1", { approved: true, note: "looks good" })
		await expect(promise).resolves.toEqual({ approved: true, note: "looks good" })
	})

	test("resume with a custom token is honoured; default tokens are random UUIDs", async () => {
		const hook = defineHook<{ x: number }>()
		const a = hook.create({ token: "alpha" })
		const b = hook.create() // random token
		expect(a.token).toBe("alpha")
		expect(b.token).not.toBe("alpha")
		expect(b.token).toMatch(/^[0-9a-f-]{36}$/i) // UUID shape
	})

	test("multiple concurrent hooks with different tokens resolve independently", async () => {
		const hook = defineHook<{ v: number }>()
		const a = hook.create({ token: "a" })
		const b = hook.create({ token: "b" })
		hook.resume("b", { v: 2 })
		hook.resume("a", { v: 1 })
		await expect(a).resolves.toEqual({ v: 1 })
		await expect(b).resolves.toEqual({ v: 2 })
	})

	test("schema validates the resume payload; valid passes through", async () => {
		const hook = defineHook<{ age: number }>({ schema: zodSchema(z.object({ age: z.number() })) })
		const p = hook.create({ token: "v1" })
		hook.resume("v1", { age: 42 })
		await expect(p).resolves.toEqual({ age: 42 })
	})

	test("schema rejects an invalid resume payload; resume throws", () => {
		const hook = defineHook<{ age: number }>({ schema: zodSchema(z.object({ age: z.number() })) })
		hook.create({ token: "bad" })
		expect(() => hook.resume("bad", { age: "not a number" } as unknown as { age: number })).toThrow(/age/)
	})

	test("schema transforms the resume payload via Zod", async () => {
		// Trim a string payload on resume.
		const hook = defineHook<string, string>({ schema: zodSchema(z.string().transform((s) => s.trim())) })
		const p = hook.create({ token: "trim" })
		hook.resume("trim", "  hello  ")
		await expect(p).resolves.toBe("hello")
	})

	test("resume with an unknown token throws", () => {
		const hook = defineHook<{ v: string }>()
		expect(() => hook.resume("missing", { v: "x" })).toThrow(/not pending/)
	})

	test("double-resume throws: the second call has no pending slot", () => {
		const hook = defineHook<{ v: string }>()
		hook.create({ token: "once" })
		hook.resume("once", { v: "first" })
		expect(() => hook.resume("once", { v: "second" })).toThrow(/not pending/)
	})

	test("reject resolves the promise with an error", async () => {
		const hook = defineHook<{ v: string }>()
		const p = hook.create({ token: "no" })
		hook.reject("no", new Error("user cancelled"))
		await expect(p).rejects.toThrow("user cancelled")
	})

	test("reject on unknown token throws", () => {
		const hook = defineHook<{ v: string }>()
		expect(() => hook.reject("nope", new Error("x"))).toThrow(/not pending/)
	})

	test("pendingCount tracks active hooks", () => {
		const hook = defineHook<{ v: string }>()
		expect(hook.pendingCount()).toBe(0)
		hook.create({ token: "p1" })
		hook.create({ token: "p2" })
		expect(hook.pendingCount()).toBe(2)
		hook.resume("p1", { v: "x" })
		expect(hook.pendingCount()).toBe(1)
	})

	test("pendingTokens lists all active hook tokens", () => {
		const hook = defineHook<{ v: string }>()
		hook.create({ token: "p1" })
		hook.create({ token: "p2" })
		expect(hook.pendingTokens().sort()).toEqual(["p1", "p2"])
	})

	test("_clear rejects all pending hooks with the 'cleared' error", async () => {
		const hook = defineHook<{ v: string }>()
		const a = hook.create({ token: "a" })
		const b = hook.create({ token: "b" })
		hook._clear()
		await expect(a).rejects.toThrow("cleared")
		await expect(b).rejects.toThrow("cleared")
		expect(hook.pendingCount()).toBe(0)
	})

	test("hook is thenable: await resolves to the resume value", async () => {
		const hook = defineHook<{ n: number }>()
		const p = hook.create({ token: "t" })
		// Schedule resume after the await is registered.
		setTimeout(() => hook.resume("t", { n: 99 }), 0)
		const v = await p
		expect(v).toEqual({ n: 99 })
	})

	test("the hook instance exposes token as an enumerable own property", () => {
		const hook = defineHook<{ v: string }>()
		const p = hook.create({ token: "tk" })
		expect(p.token).toBe("tk")
		const desc = Object.getOwnPropertyDescriptor(p, "token")
		expect(desc?.enumerable).toBe(true)
	})

	test("design-flow hooks are exported and have the right schemas", () => {
		// userInputHook: { text: string; cancelled: boolean }
		const u = userInputHook.create({ token: "u" })
		userInputHook.resume("u", { text: "hi", cancelled: false })
		expect(u).toBeInstanceOf(Promise)
		// defineApprovalHook: { approved: boolean; note?: string }
		const d = defineApprovalHook.create({ token: "d" })
		defineApprovalHook.resume("d", { approved: true, note: "ok" })
		expect(d).toBeInstanceOf(Promise)
		// developApprovalHook: { approved: boolean; edits?: string }
		const dev = developApprovalHook.create({ token: "dev" })
		developApprovalHook.resume("dev", { approved: true, edits: "rename" })
		expect(dev).toBeInstanceOf(Promise)
		// deliverApprovalHook: { approved: boolean }
		const del = deliverApprovalHook.create({ token: "del" })
		deliverApprovalHook.resume("del", { approved: true })
		expect(del).toBeInstanceOf(Promise)
	})

	test("design-flow hook schemas reject malformed payloads", () => {
		userInputHook.create({ token: "u" })
		expect(() => userInputHook.resume("u", { text: 123 as unknown as string, cancelled: false })).toThrow()
		defineApprovalHook.create({ token: "d" })
		expect(() => defineApprovalHook.resume("d", { approved: "yes" as unknown as boolean })).toThrow()
		deliverApprovalHook.create({ token: "del" })
		expect(() => deliverApprovalHook.resume("del", {} as unknown as { approved: boolean })).toThrow()
	})
})
