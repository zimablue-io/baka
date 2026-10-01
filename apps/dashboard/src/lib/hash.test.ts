import { describe, expect, it } from "vitest"
import { treeHash } from "./hash"

describe("experiment tree hash", () => {
	it("is identical for the same tree and red on drift, including same-length content", () => {
		const a = { "src/index.ts": "hello" }
		const b = { "src/index.ts": "hello" }
		const c = { "src/index.ts": "world" }
		expect(treeHash(a)).toBe(treeHash(b))
		expect(treeHash(a)).not.toBe(treeHash(c))
	})
})
