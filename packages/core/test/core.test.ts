import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRegistry, describePacks, runRecipe, validate } from "../src/index.js"
import { cleanupTempDirs, fakeProvider, GREET_PACK, tempDir, writePack } from "./helpers.js"

afterEach(() => {
	vi.unstubAllEnvs()
	cleanupTempDirs()
})

describe("explicit pack directories", () => {
	it("discovers only the given directories, never in-tree, project, or user scopes", () => {
		const root = tempDir()
		const explicit = tempDir()
		writePack(explicit, GREET_PACK)
		// Poison every implicit scope: all of these must stay invisible.
		writePack(join(root, "packs"), { name: "in-tree", recipes: GREET_PACK.recipes })
		writePack(join(root, ".baka", "packs"), { name: "project-market", recipes: GREET_PACK.recipes })
		const fakeHome = tempDir()
		writePack(join(fakeHome, "packs"), { name: "user-market", recipes: GREET_PACK.recipes })
		vi.stubEnv("BAKA_HOME", fakeHome)
		const catalog = describePacks(createRegistry({ root, packDirs: [explicit] }))
		expect(catalog.packs.map((m) => m.name)).toEqual(["hello"])
	})

	it("gives earlier directories precedence for the same pack name", () => {
		const root = tempDir()
		const first = tempDir()
		const second = tempDir()
		writePack(first, { ...GREET_PACK, version: "2.0.0" })
		writePack(second, { ...GREET_PACK, version: "1.0.0" })
		const catalog = describePacks(createRegistry({ root, packDirs: [first, second] }))
		expect(catalog.packs.map((m) => `${m.name}@${m.version}`)).toEqual(["hello@2.0.0"])
	})
})

describe("embedding surface", () => {
	it("runs a recipe with an injected provider and validates the result", async () => {
		const root = tempDir()
		const packs = tempDir()
		writePack(packs, GREET_PACK)
		const registry = createRegistry({ root, packDirs: [packs] })
		const provider = fakeProvider("Hello from the fake model.")

		const result = await runRecipe({
			registry,
			pack: "hello",
			recipe: "greet",
			params: { name: "Ada" },
			provider,
			model: "fake-model",
		})

		expect(result.ok).toBe(true)
		expect(provider.calls).toHaveLength(1)
		expect(readFileSync(join(root, "hello.md"), "utf-8")).toBe("# Ada\nHello from the fake model.\n")
		const validated = await validate(registry)
		expect(validated.valid).toBe(true)
		expect(validated.packsDiscovered).toBe(1)
	})

	it("fails closed when a slot is empty and no provider was injected", async () => {
		const root = tempDir()
		const packs = tempDir()
		writePack(packs, GREET_PACK)
		const registry = createRegistry({ root, packDirs: [packs] })
		const result = await runRecipe({ registry, pack: "hello", recipe: "greet", params: { name: "Ada" } })
		expect(result.ok).toBe(false)
		expect(result.diagnostics).toHaveLength(1)
		expect(result.diagnostics[0]?.rule).toBe("slot-no-provider")
		expect(result.diagnostics[0]?.message).toContain("no LLMProvider")
		expect(readdirSync(root)).toEqual([])
	})

	it("writes the slot cache under the project root only", async () => {
		const root = tempDir()
		const packs = tempDir()
		writePack(packs, GREET_PACK)
		mkdirSync(root, { recursive: true })
		const registry = createRegistry({ root, packDirs: [packs] })
		await runRecipe({
			registry,
			pack: "hello",
			recipe: "greet",
			params: { name: "Ada" },
			provider: fakeProvider(),
		})
		expect(readdirSync(join(root, ".baka", "slots"))).toHaveLength(1)
	})
})
