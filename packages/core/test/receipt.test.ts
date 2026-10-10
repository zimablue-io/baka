import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RecipeResultSchema } from "@repo/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { compensateRecipe, createRegistry, runRecipe, TREE_HASH_DOMAIN } from "../src/index.js"
import { cleanupTempDirs, fakeProvider, GREET_PACK, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

function greetRegistry() {
	const root = tempDir()
	const packs = tempDir()
	writePack(packs, GREET_PACK)
	return { root, registry: createRegistry({ root, packDirs: [packs] }) }
}

const RUN = { pack: "hello", recipe: "greet", params: { name: "Ada" } }

describe("receipt: changeset and outputTreeHash", () => {
	it("reports each written file with its sha256 and hashes the canonical (path, hash) list", async () => {
		const { root, registry } = greetRegistry()
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi.") })

		const body = "# Ada\nHi.\n"
		expect(result.ok).toBe(true)
		expect(result.dryRun).toBe(false)
		expect(result.changeset).toEqual([{ path: "hello.md", op: "create", contentHash: sha(body) }])
		expect(readFileSync(join(root, "hello.md"), "utf-8")).toBe(body)
		expect(result.outputTreeHash).toBe(sha(`${TREE_HASH_DOMAIN}\nhello.md\0${sha(body)}\n`))
		expect(result.diagnostics).toEqual([])
		expect(result.compensation).toEqual({
			created: ["hello.md"],
			createdDirs: [],
			overwritten: [],
			recipeData: { written: ["hello.md"] },
		})
	})

	it("is the published document baka.receipt/1, for a run that succeeded and one that did not", async () => {
		const { registry } = greetRegistry()
		const ok = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi.") })
		expect(ok.schema).toBe("baka.receipt/1")
		expect(RecipeResultSchema.strict().safeParse(ok).success).toBe(true)
		const failed = await runRecipe({ registry, ...RUN, recipe: "missing", provider: fakeProvider("Hi.") })
		expect(failed.ok).toBe(false)
		expect(RecipeResultSchema.strict().safeParse(failed).success).toBe(true)
	})

	it("returns the slot fills as data", async () => {
		const { registry } = greetRegistry()
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi."), model: "fake-model" })
		expect(result.slots).toHaveLength(1)
		expect(result.slots[0]).toMatchObject({ id: "blurb", model: "fake-model", value: "Hi.", source: "llm" })
		expect(result.slots[0]?.key).toMatch(/^[0-9a-f]{64}$/)
	})

	it("a rerun finds the files already there: `unchanged` entries and the same tree hash", async () => {
		const { registry } = greetRegistry()
		const first = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi.") })
		const second = await runRecipe({ registry, ...RUN })
		expect(second.ok).toBe(true)
		expect(second.changeset).toEqual([
			{ path: "hello.md", op: "unchanged", contentHash: first.changeset[0]?.contentHash, reason: "identical" },
		])
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
		expect(second.compensation.created).toEqual([])
	})

	it("reports an existing file with other content as skipped, hashing what is on disk", async () => {
		const { root, registry } = greetRegistry()
		writeFileSync(join(root, "hello.md"), "mine\n")
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi.") })
		expect(result.ok).toBe(true)
		expect(result.changeset).toEqual([
			{ path: "hello.md", op: "skip", contentHash: sha("mine\n"), reason: "already-exists" },
		])
		expect(readFileSync(join(root, "hello.md"), "utf-8")).toBe("mine\n")
		expect(result.outputTreeHash).toBe(sha(`${TREE_HASH_DOMAIN}\nhello.md\0${sha("mine\n")}\n`))
	})
})

describe("dryRun", () => {
	it("computes the same changeset and hash as the real run, and writes nothing", async () => {
		const dry = greetRegistry()
		const dryResult = await runRecipe({ registry: dry.registry, ...RUN, provider: fakeProvider("Hi."), dryRun: true })
		expect(dryResult.ok).toBe(true)
		expect(dryResult.dryRun).toBe(true)
		expect(readdirSync(dry.root)).toEqual([])

		const real = greetRegistry()
		const realResult = await runRecipe({ registry: real.registry, ...RUN, provider: fakeProvider("Hi.") })
		expect(dryResult.changeset).toEqual(realResult.changeset)
		expect(dryResult.outputTreeHash).toBe(realResult.outputTreeHash)
		expect(dryResult.slots).toEqual(realResult.slots)
	})

	it("leaves no trace even when the packs live inside the project (no loader cache, nothing)", async () => {
		const root = tempDir()
		writePack(join(root, "packs"), GREET_PACK)
		const registry = createRegistry({ root, packDirs: [join(root, "packs")] })
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi."), dryRun: true })
		expect(result.ok).toBe(true)
		expect(readdirSync(root)).toEqual(["packs"])
	})

	it("does not persist slot fills, so a later real run still needs a model", async () => {
		const { registry } = greetRegistry()
		await runRecipe({ registry, ...RUN, provider: fakeProvider("Hi."), dryRun: true })
		const real = await runRecipe({ registry, ...RUN })
		expect(real.ok).toBe(false)
		expect(real.diagnostics[0]?.rule).toBe("slots-open")
	})

	it("refuses a recipe with side-effect code instead of pretending", async () => {
		const root = tempDir()
		const packs = tempDir()
		writePack(packs, {
			name: "fx",
			recipes: [{ id: "touch", recipeTs: RECIPE_TOUCH }],
		})
		const registry = createRegistry({ root, packDirs: [packs] })
		const result = await runRecipe({ registry, pack: "fx", recipe: "touch", params: {}, dryRun: true })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["dry-run-unsupported"])
		expect(readdirSync(root)).toEqual([])
	})
})

const RECIPE_TOUCH = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
export const touchRecipe = {
	name: "fx.touch",
	role: "worker",
	execute: async (_input, state) => {
		writeFileSync(join(state.targetDirectory, "made.txt"), "made")
		writeFileSync(join(state.targetDirectory, "edit.txt"), "edited")
		rmSync(join(state.targetDirectory, "drop.txt"))
		return { success: true, output: { done: true }, compensationData: { made: "made.txt" } }
	},
	compensate: async (data, state) => {
		rmSync(join(state.targetDirectory, data.made), { force: true })
	},
}
`

describe("side-effect recipes", () => {
	function fxRegistry(recipeTs: string) {
		const root = tempDir()
		const packs = tempDir()
		writePack(packs, { name: "fx", recipes: [{ id: "touch", recipeTs }] })
		writeFileSync(join(root, "edit.txt"), "original")
		writeFileSync(join(root, "drop.txt"), "bye")
		mkdirSync(join(root, "node_modules"))
		writeFileSync(join(root, "node_modules", "ignored.txt"), "x")
		return { root, registry: createRegistry({ root, packDirs: [packs] }) }
	}

	it("derives create/update/delete entries from what the recipe did to the tree", async () => {
		const { root, registry } = fxRegistry(RECIPE_TOUCH)
		const result = await runRecipe({ registry, pack: "fx", recipe: "touch", params: {} })
		expect(result.ok).toBe(true)
		expect(result.output).toEqual({ done: true })
		expect(result.changeset).toEqual([
			{ path: "drop.txt", op: "delete", contentHash: null },
			{ path: "edit.txt", op: "update", contentHash: sha("edited") },
			{ path: "made.txt", op: "create", contentHash: sha("made") },
		])
		expect(result.outputTreeHash).toBe(
			sha(`${TREE_HASH_DOMAIN}\ndrop.txt\0deleted\nedit.txt\0${sha("edited")}\nmade.txt\0${sha("made")}\n`),
		)
		expect(result.compensation.recipeData).toEqual({ made: "made.txt" })
		expect(existsSync(join(root, "made.txt"))).toBe(true)
	})

	it("compensateRecipe hands the recipe's own data back to its compensate", async () => {
		const { root, registry } = fxRegistry(RECIPE_TOUCH)
		const result = await runRecipe({ registry, pack: "fx", recipe: "touch", params: {} })
		await compensateRecipe({ registry, pack: "fx", recipe: "touch", compensation: result.compensation })
		expect(existsSync(join(root, "made.txt"))).toBe(false)
	})

	it("rolls back template files and reports recipe-failed when execute reports failure", async () => {
		const root = tempDir()
		const packs = tempDir()
		writePack(packs, {
			name: "fx",
			recipes: [
				{
					id: "both",
					templates: { "out.txt.hbs": "templated\n" },
					recipeTs: `export const bothRecipe = { name: "x", role: "worker", execute: async () => ({ success: false, output: null, compensationData: null, error: "boom" }), compensate: async () => {} }`,
				},
			],
		})
		const registry = createRegistry({ root, packDirs: [packs] })
		const result = await runRecipe({ registry, pack: "fx", recipe: "both", params: {} })
		expect(result.ok).toBe(false)
		expect(result.diagnostics).toEqual([{ severity: "error", rule: "recipe-failed", message: "boom" }])
		expect(result.changeset).toEqual([])
		expect(result.compensation).toEqual({ created: [], createdDirs: [], overwritten: [], recipeData: null })
		expect(existsSync(join(root, "out.txt"))).toBe(false)
	})
})
