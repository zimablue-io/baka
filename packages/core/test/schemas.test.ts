// The published JSON Schemas (packages/core/schemas/*.json) are generated from the contract's Zod schemas.
// This test fails when they drift; `BAKA_UPDATE_SCHEMAS=1 pnpm --filter @baka/core test` rewrites them.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CONTRACT_DOCUMENT_IDS, contractJsonSchema } from "../src/index"

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas")

/** `baka.receipt/1` is published as `baka.receipt.1.json`. */
function fileFor(id: string): string {
	return `${id.replace("/", ".")}.json`
}

const rendered = new Map(
	CONTRACT_DOCUMENT_IDS.map((id) => [fileFor(id), `${JSON.stringify(contractJsonSchema(id), null, "\t")}\n`]),
)

if (process.env.BAKA_UPDATE_SCHEMAS === "1") {
	mkdirSync(dir, { recursive: true })
	for (const file of readdirSync(dir)) if (!rendered.has(file)) rmSync(join(dir, file))
	for (const [file, text] of rendered) writeFileSync(join(dir, file), text)
}

describe("the published schemas", () => {
	it("has one file per document of the contract, and nothing else", () => {
		expect(readdirSync(dir).sort()).toEqual([...rendered.keys()].sort())
	})

	it.each([...rendered])("%s matches the contract (BAKA_UPDATE_SCHEMAS=1 regenerates)", (file, text) => {
		expect(readFileSync(join(dir, file), "utf-8")).toBe(text)
	})
})
