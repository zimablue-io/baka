// ---------------------------------------------------------------------------
// Unit tests for the E2E input source. The subprocess tests and the
// real-LLM integration test rely on this; if the cursor logic is
// wrong, the tests cannot drive the CLI.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createE2EInputSource, isE2EMode, readResponses, resetDefaultE2EInputSource } from "./e2e-input"

describe("readResponses", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-e2e-input-test-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		resetDefaultE2EInputSource()
	})

	test("parses one response per line, skipping blank lines", () => {
		const file = join(tmpDir, "responses.txt")
		writeFileSync(file, "first\n\nsecond\nthird\n")
		expect(readResponses(file)).toEqual(["first", "second", "third"])
	})

	test("strips trailing \\r so Windows-style line endings don't leak into responses", () => {
		const file = join(tmpDir, "responses.txt")
		writeFileSync(file, "first\r\nsecond\r\n")
		expect(readResponses(file)).toEqual(["first", "second"])
	})

	test("handles CRLF + LF mix in the same file", () => {
		const file = join(tmpDir, "responses.txt")
		writeFileSync(file, "a\r\nb\nc\r\n")
		expect(readResponses(file)).toEqual(["a", "b", "c"])
	})
})

describe("createE2EInputSource — cursor advances in order, never skips or repeats", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-e2e-input-test-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		resetDefaultE2EInputSource()
	})

	test("returns responses in order, then null past the end", () => {
		const file = join(tmpDir, "responses.txt")
		writeFileSync(file, "a\nb\nc\n")
		const src = createE2EInputSource(file)
		expect(src.next()).toBe("a")
		expect(src.next()).toBe("b")
		expect(src.next()).toBe("c")
		expect(src.next()).toBeNull()
		expect(src.next()).toBeNull()
	})

	test("reset() rewinds the cursor to the beginning", () => {
		const file = join(tmpDir, "responses.txt")
		writeFileSync(file, "a\nb\n")
		const src = createE2EInputSource(file)
		expect(src.next()).toBe("a")
		expect(src.next()).toBe("b")
		expect(src.next()).toBeNull()
		src.reset()
		expect(src.next()).toBe("a")
	})

	test("empty file yields null on every next()", () => {
		const file = join(tmpDir, "responses.txt")
		writeFileSync(file, "")
		const src = createE2EInputSource(file)
		expect(src.next()).toBeNull()
	})

	test("an explicit empty path yields null on every next() (no file read attempted)", () => {
		const src = createE2EInputSource("")
		expect(src.next()).toBeNull()
	})
})

describe("isE2EMode", () => {
	afterEach(() => {
		// Restore the original env value; vitest doesn't automatically
		// undo process.env mutations.
		const original = process.env.BAKA_E2E_INPUT
		if (original === undefined) delete process.env.BAKA_E2E_INPUT
		else process.env.BAKA_E2E_INPUT = original
		resetDefaultE2EInputSource()
	})

	test("is false when BAKA_E2E_INPUT is not set", () => {
		delete process.env.BAKA_E2E_INPUT
		resetDefaultE2EInputSource()
		expect(isE2EMode()).toBe(false)
	})

	test("is true when BAKA_E2E_INPUT is set to a path", () => {
		process.env.BAKA_E2E_INPUT = "/tmp/whatever"
		resetDefaultE2EInputSource()
		expect(isE2EMode()).toBe(true)
	})
})
