import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRegistry, describePacks, runRecipe } from "../src/index.js"
import { cleanupTempDirs, type FixturePack, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

const BADGE: FixturePack = {
	name: "badge",
	version: "2.3.4",
	recipes: [
		{
			id: "make",
			params: [
				{ name: "title", type: "string", required: true, description: "Badge title." },
				{ name: "level", type: "number", required: false, description: "Level.", default: 1 },
				{
					name: "kind",
					type: "enum",
					required: false,
					description: "Kind.",
					enumValues: ["gold", "silver"],
					default: "gold",
				},
				{ name: "tags", type: "array", required: false, description: "Tags.", items: { type: "string" } },
				{
					name: "owner",
					type: "object",
					required: false,
					description: "Owner.",
					properties: [{ name: "login", type: "string", required: true, description: "Handle." }],
				},
			],
			templates: {
				"badge.txt.hbs": "{{title}} / level {{level}} / {{kind}}{{#each tags}} #{{this}}{{/each}}\n",
			},
		},
	],
}

function setup() {
	const root = tempDir()
	const packs = tempDir()
	writePack(packs, BADGE)
	return { root, registry: createRegistry({ root, packDirs: [packs] }) }
}

describe("describePacks: catalog with JSON Schema", () => {
	it("returns each recipe's params, a generated params schema, and the result schema", () => {
		const catalog = describePacks(setup().registry)
		expect(catalog.diagnostics).toEqual([])
		const mod = catalog.packs[0]
		expect(mod).toMatchObject({ name: "badge", version: "2.3.4" })
		const recipe = mod?.recipes[0]
		expect(recipe?.params.map((p) => p.type)).toEqual(["string", "number", "enum", "array", "object"])
		expect(recipe?.paramsSchema).toMatchObject({
			type: "object",
			additionalProperties: false,
			required: ["title"],
			properties: {
				title: { type: "string", description: "Badge title." },
				level: { type: "number", default: 1 },
				kind: { enum: ["gold", "silver"], default: "gold" },
				tags: { type: "array", items: { type: "string" } },
				owner: { type: "object", required: ["login"] },
			},
		})
		expect(catalog.resultSchema).toMatchObject({ type: "object" })
		expect(Object.keys((catalog.resultSchema as { properties: object }).properties)).toEqual(
			expect.arrayContaining(["ok", "changeset", "outputTreeHash", "slots", "compensation"]),
		)
	})

	it("is plain JSON: a stored catalog round-trips unchanged", () => {
		const catalog = describePacks(setup().registry)
		expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
	})
})

describe("runRecipe validates params against the manifest", () => {
	it("applies defaults and coerces text, so the template sees typed values", async () => {
		const { root, registry } = setup()
		const result = await runRecipe({
			registry,
			pack: "badge",
			recipe: "make",
			params: { title: "Pro", level: "3", tags: ["a", "b"] },
		})
		expect(result.ok).toBe(true)
		expect(readFileSync(join(root, "badge.txt"), "utf-8")).toBe("Pro / level 3 / gold #a #b\n")
	})

	it("treats a default and the same explicit value as the same run", async () => {
		const a = await runRecipe({
			registry: setup().registry,
			pack: "badge",
			recipe: "make",
			params: { title: "Pro" },
		})
		const b = await runRecipe({
			registry: setup().registry,
			pack: "badge",
			recipe: "make",
			params: { title: "Pro", level: 1, kind: "gold" },
		})
		expect(a.outputTreeHash).toBe(b.outputTreeHash)
	})

	it.each([
		["a missing required param", {}, "title"],
		["an undeclared param", { title: "x", typo: 1 }, "typo"],
		["a wrongly typed param", { title: "x", level: "high" }, "level"],
		["a value outside the enum", { title: "x", kind: "bronze" }, "kind"],
		["a bad nested value", { title: "x", owner: {} }, "owner.login"],
	])("rejects %s with invalid-params and writes nothing", async (_label, params, mentions) => {
		const { root, registry } = setup()
		const result = await runRecipe({ registry, pack: "badge", recipe: "make", params })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["invalid-params"])
		expect(result.diagnostics[0]?.message).toContain(mentions)
		expect(readdirSync(root)).toEqual([])
	})

	it("names the problem when the pack or recipe does not exist", async () => {
		const { registry } = setup()
		const noPack = await runRecipe({ registry, pack: "nope", recipe: "make", params: {} })
		expect(noPack.diagnostics.map((d) => d.rule)).toEqual(["pack-not-found"])
		const noRecipe = await runRecipe({ registry, pack: "badge", recipe: "nope", params: {} })
		expect(noRecipe.diagnostics.map((d) => d.rule)).toEqual(["recipe-not-found"])
	})
})
