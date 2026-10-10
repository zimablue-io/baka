import { describe, expect, it } from "vitest"
import {
	BAKA_CAPABILITIES,
	BAKA_CONTRACT_MAJOR,
	BAKA_CONTRACT_VERSION,
	CONTRACT_DOCUMENT_IDS,
	CONTRACT_DOCUMENTS,
	contractJsonSchema,
	HandshakeSchema,
	incompatibility,
	isContractDocumentId,
} from "./contract"

describe("the contract version", () => {
	it("is a semver whose major is the number at the end of every document id", () => {
		expect(BAKA_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
		expect(Number(BAKA_CONTRACT_VERSION.split(".")[0])).toBe(BAKA_CONTRACT_MAJOR)
		for (const id of CONTRACT_DOCUMENT_IDS)
			expect(id, id).toMatch(new RegExp(`^baka\\.[a-z-]+/${BAKA_CONTRACT_MAJOR}$`))
	})

	it("lists each capability once, sorted, so the handshake is stable", () => {
		expect(new Set(BAKA_CAPABILITIES).size).toBe(BAKA_CAPABILITIES.length)
		expect([...BAKA_CAPABILITIES]).toEqual([...BAKA_CAPABILITIES].sort())
	})
})

describe("the published documents", () => {
	it("gives every document a standalone JSON Schema carrying its own id", () => {
		for (const id of CONTRACT_DOCUMENT_IDS) {
			const schema = contractJsonSchema(id)
			expect(schema.title, id).toBe(id)
			expect(schema.$id, id).toBe(`https://baka.dev/schemas/${id}`)
			expect(JSON.stringify(schema), id).not.toContain('"$ref":"http')
		}
	})

	it("types the handshake and the receipt's schema field", () => {
		const handshake = HandshakeSchema.parse({
			schema: "baka.handshake/1",
			name: "baka",
			version: "0.1.0",
			contract: BAKA_CONTRACT_VERSION,
			capabilities: [...BAKA_CAPABILITIES],
			node: "v22.0.0",
		})
		expect(handshake.name).toBe("baka")
		expect(CONTRACT_DOCUMENTS["baka.receipt/1"].shape.schema.value).toBe("baka.receipt/1")
	})

	it("recognises only its own ids", () => {
		expect(isContractDocumentId("baka.receipt/1")).toBe(true)
		expect(isContractDocumentId("baka.receipt/2")).toBe(false)
		expect(isContractDocumentId("toString")).toBe(false)
	})
})

describe("incompatibility", () => {
	it("is null when the caller asks for nothing, or for what this build has", () => {
		expect(incompatibility({})).toBeNull()
		expect(incompatibility({ contract: BAKA_CONTRACT_MAJOR, capabilities: ["recipes.run", "slots.supply"] })).toBeNull()
	})

	it("refuses another contract major, saying which way to move", () => {
		const newer = incompatibility({ contract: BAKA_CONTRACT_MAJOR + 1 })
		expect(newer?.error.code).toBe("incompatible")
		expect(newer?.error.hint).toContain("Upgrade baka")
		const older = incompatibility({ contract: BAKA_CONTRACT_MAJOR - 1 })
		expect(older?.error.hint).toContain("newer")
	})

	it("names every missing capability", () => {
		const result = incompatibility({ capabilities: ["recipes.run", "teleport", "time-travel"] })
		expect(result?.error.message).toContain("teleport, time-travel")
		expect(result?.error.message).not.toContain("recipes.run")
	})
})
