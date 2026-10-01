import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BAKA_DEFAULT_WORKER_MODEL } from "@repo/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { materializeTemplates } from "./materialize.js"
import { createDiskSlotStore, writeSlotCache } from "./slot-cache.js"
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

describe("materializeTemplates — cached fills are byte-identical", () => {
	it("writes the same tree from a pinned fill without calling an LLM", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-materialize-"))
		cleanup.push(dir)
		const templates = join(dir, "templates")
		mkdirSync(templates, { recursive: true })
		writeFileSync(
			join(templates, "note.md.hbs"),
			'# {{title}}\n{{#slot "blurb" kind="prose" max=40}}one line{{/slot}}\n',
		)

		const first = await materializeTemplates({
			cwd: dir,
			templatesDir: templates,
			params: { title: "Hi" },
			provider: null,
			model: BAKA_DEFAULT_WORKER_MODEL,
			store: createDiskSlotStore(dir),
			manualFills: { blurb: "Pinned." },
		})
		expect(first.written).toEqual(["note.md"])
		expect(readFileSync(join(dir, "note.md"), "utf-8")).toBe("# Hi\nPinned.\n")

		const dir2 = mkdtempSync(join(tmpdir(), "baka-materialize-2-"))
		cleanup.push(dir2)
		mkdirSync(join(dir2, "templates"), { recursive: true })
		writeFileSync(
			join(dir2, "templates", "note.md.hbs"),
			'# {{title}}\n{{#slot "blurb" kind="prose" max=40}}one line{{/slot}}\n',
		)
		const second = await materializeTemplates({
			cwd: dir2,
			templatesDir: join(dir2, "templates"),
			params: { title: "Hi" },
			provider: null,
			model: BAKA_DEFAULT_WORKER_MODEL,
			store: createDiskSlotStore(dir2),
			manualFills: { blurb: "Pinned." },
		})
		expect(second.tree).toEqual(first.tree)
	})

	it("reads a recorded .baka/slots cache and writes the same tree with provider=null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baka-materialize-cache-"))
		cleanup.push(dir)
		const templates = join(dir, "templates")
		mkdirSync(templates, { recursive: true })
		const source = `# {{title}}\n{{#slot "blurb" kind="prose" max=40}}one line{{/slot}}\n`
		writeFileSync(join(templates, "note.md.hbs"), source)
		const params = { title: "Hi" }
		const templateHash = hashBytes(source)
		const paramsHash = hashBytes(canonicalJson(params))
		const key = slotCacheKey({
			templateHash,
			slotId: "blurb",
			paramsHash,
			model: BAKA_DEFAULT_WORKER_MODEL,
		})
		writeSlotCache(dir, {
			key,
			slotId: "blurb",
			kind: "prose",
			value: "Pinned from disk.",
			model: BAKA_DEFAULT_WORKER_MODEL,
			templateHash,
			paramsHash,
		})
		const result = await materializeTemplates({
			cwd: dir,
			templatesDir: templates,
			params,
			provider: null,
			model: BAKA_DEFAULT_WORKER_MODEL,
			store: createDiskSlotStore(dir),
		})
		expect(result.slots[0]?.cached).toBe(true)
		expect(result.tree["note.md"]).toBe("# Hi\nPinned from disk.\n")
		expect(readFileSync(join(dir, "note.md"), "utf-8")).toBe("# Hi\nPinned from disk.\n")
	})
})
