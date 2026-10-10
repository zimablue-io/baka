import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createMemorySlotStore, createRegistry, runRecipe, type SlotRecord, type SlotStore } from "../src/index.js"
import { cleanupTempDirs, fakeProvider, GREET_PACK, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

function workspace() {
	const root = tempDir()
	const packs = tempDir()
	writePack(packs, GREET_PACK)
	return { root, registry: createRegistry({ root, packDirs: [packs] }) }
}

const RUN = { pack: "hello", recipe: "greet", params: { name: "Ada" } }

/** A store that records every read and write, so a test can prove a mode never touched it. */
function spyStore(inner: SlotStore): SlotStore & { reads: string[]; writes: string[] } {
	const reads: string[] = []
	const writes: string[] = []
	return {
		reads,
		writes,
		read: (key) => {
			reads.push(key)
			return inner.read(key)
		},
		write: (record) => {
			writes.push(record.key)
			inner.write(record)
		},
	}
}

describe("slot records: live then replay", () => {
	it("replays a live run's records with no provider and produces the identical outputTreeHash", async () => {
		const live = workspace()
		const provider = fakeProvider("A model-written sentence.")
		const liveResult = await runRecipe({
			registry: live.registry,
			...RUN,
			provider,
			model: "fake-model",
			slots: { mode: "live" },
		})
		expect(liveResult.ok).toBe(true)
		expect(provider.calls).toHaveLength(1)
		expect(liveResult.slots).toHaveLength(1)

		// A different checkout, no provider, a cold cache: only the records.
		const replay = workspace()
		const replayResult = await runRecipe({
			registry: replay.registry,
			...RUN,
			slots: { mode: "replay", records: liveResult.slots },
		})

		expect(replayResult.ok).toBe(true)
		expect(replayResult.outputTreeHash).toBe(liveResult.outputTreeHash)
		expect(replayResult.changeset).toEqual(liveResult.changeset)
		expect(readFileSync(join(replay.root, "hello.md"), "utf-8")).toBe(
			readFileSync(join(live.root, "hello.md"), "utf-8"),
		)
		expect(replayResult.slots).toEqual(liveResult.slots.map((r) => ({ ...r, source: "replay" })))
		// Replay does not create a slot cache either.
		expect(existsSync(join(replay.root, ".baka"))).toBe(false)
	})

	it("survives a JSON round trip, which is how a stored receipt comes back", async () => {
		const live = workspace()
		const liveResult = await runRecipe({ registry: live.registry, ...RUN, provider: fakeProvider("Stored.") })
		const stored = JSON.parse(JSON.stringify(liveResult)) as { slots: SlotRecord[] }
		const replay = workspace()
		const replayResult = await runRecipe({
			registry: replay.registry,
			...RUN,
			slots: { mode: "replay", records: stored.slots },
		})
		expect(replayResult.outputTreeHash).toBe(liveResult.outputTreeHash)
	})
})

describe("replay is strict", () => {
	it("fails with slot-record-missing and makes no model call, even when a provider is supplied", async () => {
		const { root, registry } = workspace()
		const provider = fakeProvider("must never be asked")
		const result = await runRecipe({ registry, ...RUN, provider, slots: { mode: "replay", records: [] } })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slot-record-missing"])
		expect(result.diagnostics[0]?.message).toContain('"blurb"')
		expect(provider.calls).toHaveLength(0)
		expect(readdirSync(root)).toEqual([])
	})

	it("treats an omitted records list as empty", async () => {
		const { registry } = workspace()
		const provider = fakeProvider()
		const result = await runRecipe({ registry, ...RUN, provider, slots: { mode: "replay" } })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slot-record-missing"])
		expect(provider.calls).toHaveLength(0)
	})

	it("rejects a record taken against other params as slot-record-stale, with no model call", async () => {
		const source = workspace()
		const recorded = await runRecipe({
			registry: source.registry,
			pack: "hello",
			recipe: "greet",
			params: { name: "Grace" },
			provider: fakeProvider("For Grace."),
		})
		const { registry } = workspace()
		const provider = fakeProvider()
		const result = await runRecipe({ registry, ...RUN, provider, slots: { mode: "replay", records: recorded.slots } })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slot-record-stale"])
		expect(provider.calls).toHaveLength(0)
	})

	it("rejects a record whose value does not fit the slot schema", async () => {
		const source = workspace()
		const recorded = await runRecipe({ registry: source.registry, ...RUN, provider: fakeProvider("ok") })
		const bad = recorded.slots.map((r) => ({ ...r, value: "x".repeat(500) })) // slot max is 80 chars
		const { registry } = workspace()
		const result = await runRecipe({ registry, ...RUN, slots: { mode: "replay", records: bad } })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slot-fill-invalid"])
	})

	it("never reads or writes the slot store", async () => {
		const { registry } = workspace()
		const recorded = await runRecipe({
			registry: workspace().registry,
			...RUN,
			provider: fakeProvider("From records."),
		})
		const store = spyStore(createMemorySlotStore())
		const result = await runRecipe({ registry, ...RUN, store, slots: { mode: "replay", records: recorded.slots } })
		expect(result.ok).toBe(true)
		expect(store.reads).toEqual([])
		expect(store.writes).toEqual([])
	})
})

describe("live and record modes", () => {
	it("live reads the cache before asking the model", async () => {
		const { registry } = workspace()
		const store = createMemorySlotStore()
		const first = fakeProvider("Cached sentence.")
		await runRecipe({ registry, ...RUN, provider: first, store })
		const second = fakeProvider("Different sentence.")
		const result = await runRecipe({ registry, ...RUN, provider: second, store })
		expect(second.calls).toHaveLength(0)
		expect(result.slots[0]).toMatchObject({ source: "cache", value: "Cached sentence." })
	})

	it("record always asks the model, ignores the cache, and refreshes it", async () => {
		const { registry } = workspace()
		const store = createMemorySlotStore()
		await runRecipe({ registry, ...RUN, provider: fakeProvider("Old."), store })
		const fresh = fakeProvider("New.")
		const result = await runRecipe({ registry, ...RUN, provider: fresh, store, slots: { mode: "record" } })
		expect(fresh.calls).toHaveLength(1)
		expect(result.slots[0]).toMatchObject({ source: "llm", value: "New." })

		const later = await runRecipe({ registry, ...RUN, store })
		expect(later.slots[0]).toMatchObject({ source: "cache", value: "New." })
	})

	it("record without a provider is slots-open, not a cache hit", async () => {
		const { registry } = workspace()
		const store = createMemorySlotStore()
		await runRecipe({ registry, ...RUN, provider: fakeProvider("Warm."), store })
		const result = await runRecipe({ registry, ...RUN, store, slots: { mode: "record" } })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slots-open"])
	})

	it("reports a provider failure as slot-provider-error", async () => {
		const { registry } = workspace()
		const provider = fakeProvider()
		provider.chat = async () => {
			throw new Error("connection refused")
		}
		const result = await runRecipe({ registry, ...RUN, provider })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slot-provider-error"])
		expect(result.diagnostics[0]?.message).toContain("connection refused")
	})

	it("reports a model answer that breaks the slot schema as slot-fill-invalid", async () => {
		const { registry } = workspace()
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider(["not", "a", "string"]) })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["slot-fill-invalid"])
	})
})
