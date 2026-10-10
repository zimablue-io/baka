import { describe, expect, it } from "vitest"
import { defaultParamValues, errorDetail, paramsFromFields } from "./engine"

describe("recipe form from any pack schema", () => {
	it("starts every declared param empty so switching recipes cannot keep leftover JSON", () => {
		expect(
			defaultParamValues([
				{ name: "title", type: "string", required: true },
				{ name: "tone", type: "string" },
			]),
		).toEqual({ title: "", tone: "" })
	})

	it("omits optional blanks and keeps required strings", () => {
		expect(
			paramsFromFields({ title: "Note", tone: "" }, [
				{ name: "title", type: "string", required: true },
				{ name: "tone", type: "string" },
			]),
		).toEqual({ title: "Note" })
	})
})

describe("what the engine says when a call fails", () => {
	it("reads the message of the error document { error: { code, message } }", () => {
		expect(errorDetail({ error: { code: "recipe-not-found", message: 'no recipe "x"' } }, "GET /v1/run 400")).toBe(
			'no recipe "x"',
		)
	})

	it("reads the first error diagnostic of a failed receipt", () => {
		expect(
			errorDetail(
				{ ok: false, diagnostics: [{ severity: "error", rule: "slots-open", message: "slots are open: line" }] },
				"POST /v1/run 400",
			),
		).toBe("slots are open: line")
	})

	it("falls back to the status line for anything else", () => {
		expect(errorDetail({}, "GET /v1/packs 500")).toBe("GET /v1/packs 500")
		expect(errorDetail(null, "GET /v1/packs 500")).toBe("GET /v1/packs 500")
	})
})
