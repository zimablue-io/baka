// ---------------------------------------------------------------------------
// Unit tests for recipe-loader.ts.
//
// These tests pin the export resolution order for recipe ids, including
// hyphenated ids that resolve through their camelCase export names.
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PackManifest } from "@repo/protocol"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadRecipe } from "./recipe-loader.js"

let tempDir: string

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "baka-loader-"))
})

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

function manifestFixture(recipeId: string): PackManifest {
	return {
		name: "fixture",
		version: "0.0.1",
		description: "test fixture",
		dependencies: [],
		conflictsWith: [],
		recipes: [
			{
				id: recipeId,
				description: "fixture recipe",
				requiresReasoning: false,
				filePatterns: [],
				validators: [],
				params: [],
			},
		],
		packValidators: [],
	}
}

function writeRecipeFile(recipeId: string, source: string): void {
	const recipeDir = join(tempDir, recipeId)
	mkdirSync(recipeDir, { recursive: true })
	writeFileSync(join(recipeDir, "recipe.ts"), source, "utf-8")
}

describe("loadRecipe", () => {
	it("resolves a hyphenated recipe id by its camelCase export", async () => {
		const manifest = manifestFixture("add-script")
		writeRecipeFile(
			"add-script",
			`export const addScriptRecipe = {
				execute: async () => ({ success: true, output: "add-script-ok" }),
				compensate: async () => {},
			}`,
		)

		const loaded = loadRecipe<unknown, string, unknown>(tempDir, tempDir, manifest, "add-script")
		expect(loaded.recipeId).toBe("add-script")

		const result = await loaded.step.execute({}, {} as never, {} as never)
		expect(result.success).toBe(true)
		expect(result.output).toBe("add-script-ok")
	})

	it("prefers camelCase(id)Recipe over the default export", async () => {
		const manifest = manifestFixture("pick")
		writeRecipeFile(
			"pick",
			`export const pickRecipe = {
				execute: async () => ({ success: true, output: "pickRecipe" }),
				compensate: async () => {},
			}
			export default {
				execute: async () => ({ success: true, output: "default" }),
				compensate: async () => {},
			}`,
		)

		const loaded = loadRecipe<unknown, string, unknown>(tempDir, tempDir, manifest, "pick")
		const result = await loaded.step.execute({}, {} as never, {} as never)
		expect(result.output).toBe("pickRecipe")
	})

	it("still resolves non-hyphenated ids through the legacy idRecipe shape", async () => {
		const manifest = manifestFixture("scaffold")
		writeRecipeFile(
			"scaffold",
			`export const scaffoldRecipe = {
				execute: async () => ({ success: true, output: "scaffoldRecipe" }),
				compensate: async () => {},
			}`,
		)

		const loaded = loadRecipe<unknown, string, unknown>(tempDir, tempDir, manifest, "scaffold")
		const result = await loaded.step.execute({}, {} as never, {} as never)
		expect(result.output).toBe("scaffoldRecipe")
	})

	it("throws an honest error when no candidate export resolves", () => {
		const manifest = manifestFixture("bad-recipe")
		writeRecipeFile(
			"bad-recipe",
			`export const somethingElse = {
				execute: async () => ({ success: true }),
				compensate: async () => {},
			}`,
		)

		expect(() => loadRecipe(tempDir, tempDir, manifest, "bad-recipe")).toThrow(/must export/)
	})
})
