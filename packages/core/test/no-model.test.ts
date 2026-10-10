import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRegistry, runRecipe } from "../src/index.js"
import { cleanupTempDirs, fakeProvider, GREET_PACK, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

function workspace() {
	const root = tempDir()
	const packs = tempDir()
	writePack(packs, GREET_PACK)
	return { root, registry: createRegistry({ root, packDirs: [packs] }) }
}

const RUN = { pack: "hello", recipe: "greet", params: { name: "Ada" } }

describe("a run with no model", () => {
	it("reports every open slot instead of a bare failure, and writes nothing", async () => {
		const { root, registry } = workspace()
		const result = await runRecipe({ registry, ...RUN })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slots-open"])
		expect(result.openSlots).toEqual([
			expect.objectContaining({ id: "blurb", kind: "prose", max: 80, file: "hello.md.hbs", hint: "one sentence" }),
		])
		expect(result.openSlots?.[0]?.templateKey).toMatch(/^[0-9a-f]{64}$/)
		expect(result.changeset).toEqual([])
		expect(existsSync(join(root, "hello.md"))).toBe(false)
	})

	it("reports open slots in a dry run too", async () => {
		const { registry } = workspace()
		const result = await runRecipe({ registry, ...RUN, dryRun: true })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slots-open"])
		expect(result.openSlots).toHaveLength(1)
	})

	it("fills the slots from values the caller supplies for this call", async () => {
		const { root, registry } = workspace()
		const result = await runRecipe({ registry, ...RUN, slots: { mode: "live", values: { blurb: "Hello, Ada." } } })
		expect(result.ok).toBe(true)
		expect(result.openSlots).toBeUndefined()
		expect(readFileSync(join(root, "hello.md"), "utf-8")).toContain("Hello, Ada.")
		expect(result.slots).toEqual([expect.objectContaining({ id: "blurb", value: "Hello, Ada.", source: "supplied" })])
	})

	it("prefers a supplied value to the model and never calls it", async () => {
		const { registry } = workspace()
		const provider = fakeProvider("from the model")
		const result = await runRecipe({
			registry,
			...RUN,
			provider,
			slots: { mode: "live", values: { blurb: "Mine." } },
		})
		expect(result.ok).toBe(true)
		expect(provider.calls).toHaveLength(0)
	})

	it("does not write supplied values to the slot cache", async () => {
		const { root, registry } = workspace()
		await runRecipe({ registry, ...RUN, slots: { mode: "live", values: { blurb: "Mine." } } })
		expect(existsSync(join(root, ".baka", "slots"))).toBe(false)
	})

	it("rejects a supplied value that does not fit the slot", async () => {
		const { registry } = workspace()
		const result = await runRecipe({ registry, ...RUN, slots: { mode: "live", values: { blurb: 42 } } })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slot-fill-invalid"])
	})

	it("rejects a supplied value for a slot the recipe does not declare", async () => {
		const { registry } = workspace()
		const result = await runRecipe({
			registry,
			...RUN,
			slots: { mode: "live", values: { blurb: "ok", nope: "x" } },
		})
		expect(result.ok).toBe(false)
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ rule: "slot-unknown", message: expect.stringContaining("nope") }),
		])
	})

	it("replays a run whose fills were supplied, with the identical tree hash", async () => {
		const first = workspace()
		const supplied = await runRecipe({
			registry: first.registry,
			...RUN,
			slots: { mode: "live", values: { blurb: "Hi." } },
		})
		const second = workspace()
		const replayed = await runRecipe({
			registry: second.registry,
			...RUN,
			slots: { mode: "replay", records: supplied.slots },
		})
		expect(replayed.ok).toBe(true)
		expect(replayed.outputTreeHash).toBe(supplied.outputTreeHash)
	})
})
