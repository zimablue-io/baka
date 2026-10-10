import { afterEach, describe, expect, it } from "vitest"
import { createRegistry, findRecipePack } from "../src/index.js"
import { cleanupTempDirs, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

function registryWith(...packs: Array<{ name: string; recipes: string[] }>) {
	const root = tempDir()
	const dir = tempDir()
	for (const pack of packs) writePack(dir, { name: pack.name, recipes: pack.recipes.map((id) => ({ id })) })
	return createRegistry({ root, packDirs: [dir] })
}

describe("findRecipePack", () => {
	it("names the one pack that declares a recipe, so a recipe can be run by its own name", () => {
		const registry = registryWith(
			{ name: "web", recipes: ["add-login", "add-page"] },
			{ name: "docs", recipes: ["add-readme"] },
		)
		expect(findRecipePack(registry, "add-login")).toBe("web")
		expect(findRecipePack(registry, "add-readme")).toBe("docs")
	})

	it("fails with recipe-not-found, listing what is installed, when nothing declares it", () => {
		const registry = registryWith({ name: "web", recipes: ["add-login"] })
		expect(() => findRecipePack(registry, "add-logout")).toThrowError(
			expect.objectContaining({ code: "recipe-not-found", message: expect.stringContaining("web/add-login") }),
		)
	})

	it("fails with recipe-ambiguous, naming every candidate, when several packs declare it", () => {
		const registry = registryWith({ name: "web", recipes: ["init"] }, { name: "cli", recipes: ["init"] })
		expect(() => findRecipePack(registry, "init")).toThrowError(
			expect.objectContaining({
				code: "recipe-ambiguous",
				message: expect.stringMatching(/cli\/init.*web\/init|web\/init.*cli\/init/),
			}),
		)
	})
})
