// ---------------------------------------------------------------------------
// Unit tests for the pure decision functions. These tests target the
// user-typed input mapped to the workflow's resume() shape.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "vitest"
import { parseDefineApproval, parseDeliverApproval, parseDevelopApproval } from "./parse"

describe("parseDefineApproval — 'approve the roster? (yes / no <reason>)'", () => {
	test("null input (inquirer force-closed) is a rejection with a clear reason", () => {
		expect(parseDefineApproval(null)).toEqual({ approved: false, note: "user force-closed" })
	})

	test("'y' / 'yes' / 'Y' / 'Yes' all approve", () => {
		for (const input of ["y", "Y", "yes", "Yes", "YES", "yep", "yeah", "go", "approve", "Approve"]) {
			const r = parseDefineApproval(input)
			expect(r.approved).toBe(true)
		}
	})

	test("'no <reason>' is a rejection with the trimmed reason", () => {
		expect(parseDefineApproval("no  rename to scaffold2")).toEqual({
			approved: false,
			note: "rename to scaffold2",
		})
	})

	test("bare 'no' (no reason) is a rejection with a sentinel note", () => {
		expect(parseDefineApproval("no")).toEqual({ approved: false, note: "no reason given" })
	})

	test("anything that isn't a yes/no is treated as a rejection with the whole text as the note", () => {
		expect(parseDefineApproval("rename it")).toEqual({ approved: false, note: "rename it" })
	})
})

describe("parseDevelopApproval — 'approve the design? (yes / edit <text>)'", () => {
	test("null input is a rejection with a clear reason", () => {
		expect(parseDevelopApproval(null)).toEqual({ approved: false, edits: "user force-closed" })
	})

	test("'y' / 'yes' / 'go' / 'approve' all approve", () => {
		for (const input of ["y", "yes", "Yes", "go", "approve"]) {
			const r = parseDevelopApproval(input)
			expect(r.approved).toBe(true)
		}
	})

	test("'edit <text>' is a rejection with the trimmed edit", () => {
		expect(parseDevelopApproval("edit  rename param to name")).toEqual({
			approved: false,
			edits: "rename param to name",
		})
	})

	test("bare 'edit' is a rejection with a sentinel edit", () => {
		expect(parseDevelopApproval("edit")).toEqual({ approved: false, edits: "no edits specified" })
	})

	test("anything that isn't a yes/edit is treated as a rejection with the whole text as the edit", () => {
		expect(parseDevelopApproval("drop the validators")).toEqual({ approved: false, edits: "drop the validators" })
	})
})

describe("parseDeliverApproval — 'proceed? (yes / no)'", () => {
	test("null input is a rejection", () => {
		expect(parseDeliverApproval(null)).toEqual({ approved: false })
	})

	test("'y' / 'yes' / 'go' all approve", () => {
		for (const input of ["y", "Y", "yes", "Yes", "YES", "go"]) {
			const r = parseDeliverApproval(input)
			expect(r.approved).toBe(true)
		}
	})

	test("'no' and any other text is a rejection", () => {
		for (const input of ["no", "n", "nope", "cancel"]) {
			const r = parseDeliverApproval(input)
			expect(r.approved).toBe(false)
		}
	})
})
