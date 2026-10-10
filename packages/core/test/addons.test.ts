// The extension point: a closed add-on attaches to the open engine through `addons` on a call,
// without patching it. It can refuse a run before anything is written, and it sees every receipt.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type BakaAddon, createRegistry, runRecipe } from "../src/index.js"
import { cleanupTempDirs, fakeProvider, GREET_PACK, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

function greet() {
	const root = tempDir()
	const packs = tempDir()
	writePack(packs, GREET_PACK)
	return { root, registry: createRegistry({ root, packDirs: [packs] }) }
}

const RUN = { pack: "hello", recipe: "greet", params: { name: "Ada" } }

describe("add-ons", () => {
	it("beforeRun sees what is about to run, pinned, and afterRun sees the receipt", async () => {
		const { registry } = greet()
		const seen: string[] = []
		const addon: BakaAddon = {
			name: "audit",
			beforeRun(request) {
				seen.push(
					`before ${request.pack}/${request.recipe} ${request.pin.contentHash.slice(0, 8)} dry=${request.dryRun}`,
				)
			},
			afterRun(receipt) {
				seen.push(`after ok=${receipt.ok} ${receipt.outputTreeHash.slice(0, 8)}`)
			},
		}
		const receipt = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi."), addons: [addon] })
		expect(receipt.ok).toBe(true)
		expect(seen).toEqual([
			`before hello/greet ${receipt.pins[0]?.contentHash.slice(0, 8)} dry=false`,
			`after ok=true ${receipt.outputTreeHash.slice(0, 8)}`,
		])
	})

	it("a beforeRun that throws refuses the run before anything is written", async () => {
		const { root, registry } = greet()
		const addon: BakaAddon = {
			name: "governance",
			beforeRun() {
				throw new Error("pack hello is not approved for this organization")
			},
		}
		const receipt = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi."), addons: [addon] })
		expect(receipt.ok).toBe(false)
		expect(receipt.diagnostics[0]).toMatchObject({ severity: "error", rule: "addon-refused" })
		expect(receipt.diagnostics[0]?.message).toContain("governance: pack hello is not approved")
		expect(existsSync(join(root, "hello.md"))).toBe(false)
	})

	it("afterRun also sees a refused run, so a history add-on records it", async () => {
		const { registry } = greet()
		const rules: string[] = []
		const addons: BakaAddon[] = [
			{
				name: "gate",
				beforeRun() {
					throw new Error("no")
				},
			},
			{ name: "history", afterRun: (receipt) => void rules.push(receipt.diagnostics[0]?.rule ?? "ok") },
		]
		await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi."), addons })
		expect(rules).toEqual(["addon-refused"])
	})

	it("an afterRun that fails does not change the result; the receipt says so with a warning", async () => {
		const { root, registry } = greet()
		const addon: BakaAddon = {
			name: "sync",
			afterRun() {
				throw new Error("sync service unreachable")
			},
		}
		const receipt = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi."), addons: [addon] })
		expect(receipt.ok).toBe(true)
		expect(existsSync(join(root, "hello.md"))).toBe(true)
		expect(receipt.diagnostics).toContainEqual({
			severity: "warning",
			rule: "addon-failed",
			message: "sync: sync service unreachable",
		})
	})

	it("a run without add-ons is unchanged", async () => {
		const { registry } = greet()
		const receipt = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi.") })
		expect(receipt.ok).toBe(true)
		expect(receipt.diagnostics).toEqual([])
	})
})
