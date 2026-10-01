import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BAKA_DEFAULT_WORKER_MODEL } from "@repo/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { applyPlan, planTemplates } from "./materialize.js"
import { createDiskSlotStore, createMemorySlotStore, writeSlotCache } from "./slot-cache.js"
import { canonicalJson, hashBytes, slotCacheKey } from "./slots.js"

const cleanup: string[] = []
afterEach(() => {
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

const NOTE = '# {{title}}\n{{#slot "blurb" kind="prose" max=40}}one line{{/slot}}\n'

function project(): { dir: string; templates: string } {
	const dir = mkdtempSync(join(tmpdir(), "baka-materialize-"))
	cleanup.push(dir)
	const templates = join(dir, "templates")
	mkdirSync(templates, { recursive: true })
	writeFileSync(join(templates, "note.md.hbs"), NOTE)
	return { dir, templates }
}

function pin(dir: string, params: Record<string, unknown>, value: string): void {
	const templateHash = hashBytes(NOTE)
	const paramsHash = hashBytes(canonicalJson(params))
	writeSlotCache(dir, {
		key: slotCacheKey({ templateHash, slotId: "blurb", paramsHash, model: BAKA_DEFAULT_WORKER_MODEL }),
		slotId: "blurb",
		kind: "prose",
		value,
		model: BAKA_DEFAULT_WORKER_MODEL,
		templateHash,
		paramsHash,
	})
}

describe("planTemplates", () => {
	it("reads a recorded .baka/slots cache and plans the same bytes with provider=null", async () => {
		const { dir, templates } = project()
		const params = { title: "Hi" }
		pin(dir, params, "Pinned from disk.")
		const plan = await planTemplates({
			root: dir,
			templatesDir: templates,
			params,
			provider: null,
			model: BAKA_DEFAULT_WORKER_MODEL,
			store: createDiskSlotStore(dir),
			persist: true,
			slotMode: "live",
			records: [],
		})
		expect(plan.slots).toHaveLength(1)
		expect(plan.slots[0]).toMatchObject({ id: "blurb", source: "cache", value: "Pinned from disk." })
		expect(plan.files).toHaveLength(1)
		expect(plan.files[0]).toMatchObject({ path: "note.md", op: "create", content: "# Hi\nPinned from disk.\n" })
		// Planning alone never writes the project files.
		expect(existsSync(join(dir, "note.md"))).toBe(false)
	})

	it("plans identical hashes in two separate projects that share the same recorded fill", async () => {
		const params = { title: "Hi" }
		const hashes: Array<string | null> = []
		for (let i = 0; i < 2; i++) {
			const { dir, templates } = project()
			pin(dir, params, "Pinned.")
			const plan = await planTemplates({
				root: dir,
				templatesDir: templates,
				params,
				provider: null,
				model: BAKA_DEFAULT_WORKER_MODEL,
				store: createDiskSlotStore(dir),
				persist: true,
				slotMode: "live",
				records: [],
			})
			hashes.push(plan.files[0]?.contentHash ?? null)
		}
		expect(hashes[0]).toBe(hashes[1])
		expect(hashes[0]).toBe(hashBytes("# Hi\nPinned.\n"))
	})

	it("does not write fresh fills to the store when persist is false", async () => {
		const { dir, templates } = project()
		const store = createMemorySlotStore()
		const provider = {
			name: "fake",
			validateConfig: () => {},
			chat: async <T>() => ({
				content: { value: "Fresh." } as T,
				usage: { promptTokens: 0, completionTokens: 0 },
				raw: null,
			}),
		}
		const plan = await planTemplates({
			root: dir,
			templatesDir: templates,
			params: { title: "Hi" },
			provider,
			model: "fake-model",
			store,
			persist: false,
			slotMode: "live",
			records: [],
		})
		expect(plan.slots[0]).toMatchObject({ source: "llm", model: "fake-model", value: "Fresh." })
		expect(existsSync(join(dir, ".baka"))).toBe(false)
		const key = slotCacheKey({
			templateHash: hashBytes(NOTE),
			slotId: "blurb",
			paramsHash: hashBytes(canonicalJson({ title: "Hi" })),
			model: "fake-model",
		})
		expect(store.read(key)).toBeNull()
	})
})

describe("applyPlan", () => {
	it("writes the planned creates and reports what it created", async () => {
		const { dir, templates } = project()
		pin(dir, { title: "Hi" }, "Pinned.")
		const plan = await planTemplates({
			root: dir,
			templatesDir: templates,
			params: { title: "Hi" },
			provider: null,
			model: BAKA_DEFAULT_WORKER_MODEL,
			store: createDiskSlotStore(dir),
			persist: true,
			slotMode: "live",
			records: [],
		})
		const done = applyPlan(dir, plan)
		expect(done).toEqual({ created: ["note.md"], overwritten: [] })
		expect(existsSync(join(dir, "note.md"))).toBe(true)
	})
})
