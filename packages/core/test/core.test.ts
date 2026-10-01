import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRegistry, describeModules, runAction, validate } from "../src/index.js"
import { cleanupTempDirs, fakeProvider, GREET_MODULE, tempDir, writeModule } from "./helpers.js"

afterEach(() => {
	vi.unstubAllEnvs()
	cleanupTempDirs()
})

describe("explicit module directories", () => {
	it("discovers only the given directories, never in-tree, project, or user scopes", () => {
		const root = tempDir()
		const explicit = tempDir()
		writeModule(explicit, GREET_MODULE)
		// Poison every implicit scope: all of these must stay invisible.
		writeModule(join(root, "modules"), { name: "in-tree", actions: GREET_MODULE.actions })
		writeModule(join(root, ".baka", "modules"), { name: "project-market", actions: GREET_MODULE.actions })
		const fakeHome = tempDir()
		writeModule(join(fakeHome, "modules"), { name: "user-market", actions: GREET_MODULE.actions })
		vi.stubEnv("BAKA_HOME", fakeHome)
		const catalog = describeModules(createRegistry({ root, moduleDirs: [explicit] }))
		expect(catalog.modules.map((m) => m.name)).toEqual(["hello"])
	})

	it("gives earlier directories precedence for the same module name", () => {
		const root = tempDir()
		const first = tempDir()
		const second = tempDir()
		writeModule(first, { ...GREET_MODULE, version: "2.0.0" })
		writeModule(second, { ...GREET_MODULE, version: "1.0.0" })
		const catalog = describeModules(createRegistry({ root, moduleDirs: [first, second] }))
		expect(catalog.modules.map((m) => `${m.name}@${m.version}`)).toEqual(["hello@2.0.0"])
	})
})

describe("embedding surface", () => {
	it("runs an action with an injected provider and validates the result", async () => {
		const root = tempDir()
		const modules = tempDir()
		writeModule(modules, GREET_MODULE)
		const registry = createRegistry({ root, moduleDirs: [modules] })
		const provider = fakeProvider("Hello from the fake model.")

		const result = await runAction({
			registry,
			module: "hello",
			action: "greet",
			params: { name: "Ada" },
			provider,
			model: "fake-model",
		})

		expect(result.ok).toBe(true)
		expect(provider.calls).toHaveLength(1)
		expect(readFileSync(join(root, "hello.md"), "utf-8")).toBe("# Ada\nHello from the fake model.\n")
		const validated = await validate(registry)
		expect(validated.valid).toBe(true)
		expect(validated.modulesDiscovered).toBe(1)
	})

	it("fails closed when a slot is empty and no provider was injected", async () => {
		const root = tempDir()
		const modules = tempDir()
		writeModule(modules, GREET_MODULE)
		const registry = createRegistry({ root, moduleDirs: [modules] })
		const result = await runAction({ registry, module: "hello", action: "greet", params: { name: "Ada" } })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("no LLMProvider")
		expect(readdirSync(root)).toEqual([])
	})

	it("writes the slot cache under the project root only", async () => {
		const root = tempDir()
		const modules = tempDir()
		writeModule(modules, GREET_MODULE)
		mkdirSync(root, { recursive: true })
		const registry = createRegistry({ root, moduleDirs: [modules] })
		await runAction({
			registry,
			module: "hello",
			action: "greet",
			params: { name: "Ada" },
			provider: fakeProvider(),
		})
		expect(readdirSync(join(root, ".baka", "slots"))).toHaveLength(1)
	})
})
