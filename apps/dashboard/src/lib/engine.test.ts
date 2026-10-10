import { describe, expect, it } from "vitest"
import { defaultParamValues, paramsFromFields } from "./engine"

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
