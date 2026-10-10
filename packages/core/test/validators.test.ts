import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRegistry, runRecipe, validate } from "../src/index.js"
import { cleanupTempDirs, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

/** A validator file exporting `name` that returns `body` (a JS expression evaluating to an array). */
const validatorFile = (name: string, body: string) =>
	`export async function ${name}(state) {\n\tvoid state\n\treturn ${body}\n}\n`

function setup(mod: Parameters<typeof writePack>[1]) {
	const root = tempDir()
	const packs = tempDir()
	writePack(packs, mod)
	return { root, packs, registry: createRegistry({ root, packDirs: [packs] }) }
}

const OK_TEMPLATE = { "out.txt.hbs": "ok\n" }

describe("diagnostics from validators", () => {
	it("reports warnings when validation passes", async () => {
		const { registry } = setup({
			name: "m",
			recipes: [{ id: "gen", templates: OK_TEMPLATE, validators: ["warnOnly"] }],
			files: {
				"gen/validators/warn-only.ts": validatorFile(
					"warnOnly",
					`[{ severity: "warning", rule: "soft", message: "just so you know", file: "out.txt" }]`,
				),
			},
		})
		const result = await runRecipe({ registry, pack: "m", recipe: "gen", params: {} })
		expect(result.ok).toBe(true)
		expect(result.diagnostics).toEqual([
			{
				severity: "warning",
				rule: "soft",
				message: "just so you know",
				file: "out.txt",
				validator: "m.gen:warnOnly",
			},
		])
	})

	it("keeps the validator's own rule id and adds the namespaced validator id beside it", async () => {
		const { registry } = setup({
			name: "m",
			recipes: [{ id: "gen", templates: OK_TEMPLATE, validators: ["recipeCheck"] }],
			packValidators: ["packCheck"],
			files: {
				"gen/validators/recipe-check.ts": validatorFile(
					"recipeCheck",
					`[{ severity: "error", rule: "has-greeting", message: "no greeting" }, { severity: "warning", message: "rule-less" }]`,
				),
				"_shared/validators/pack-check.ts": validatorFile(
					"packCheck",
					`[{ severity: "error", rule: "shared-rule", message: "bad tree" }]`,
				),
			},
		})
		const result = await runRecipe({ registry, pack: "m", recipe: "gen", params: {} })
		expect(result.ok).toBe(false)
		expect(result.diagnostics).toEqual([
			{ severity: "error", rule: "shared-rule", message: "bad tree", validator: "m:packCheck" },
			{ severity: "error", rule: "has-greeting", message: "no greeting", validator: "m.gen:recipeCheck" },
			// a validator that sets no rule is identified by its own id
			{ severity: "warning", rule: "recipeCheck", message: "rule-less", validator: "m.gen:recipeCheck" },
		])
	})

	it("turns a validator that throws into a validator-error naming the validator", async () => {
		const { registry } = setup({
			name: "m",
			recipes: [{ id: "gen", templates: OK_TEMPLATE, validators: ["boom"] }],
			files: { "gen/validators/boom.ts": `export async function boom() { throw new Error("kaput") }\n` },
		})
		const result = await runRecipe({ registry, pack: "m", recipe: "gen", params: {} })
		expect(result.ok).toBe(false)
		expect(result.diagnostics).toEqual([
			{ severity: "error", rule: "validator-error", message: "kaput", validator: "m.gen:boom" },
		])
	})
})

describe("the run context validators receive in state.run", () => {
	const REPORT = `[{ severity: "warning", rule: "ctx", message: JSON.stringify({
		pack: state.run.pack, recipe: state.run.recipe, ran: state.run.ran, params: state.run.params,
		compensationData: state.run.compensationData, output: state.run.output,
		changeset: state.run.changeset.map((e) => e.path + ":" + e.op), detected: state.run.detected ?? null,
	}) }]`

	it("gives a recipe validator the params, the recipe's data and output, and ran: true", async () => {
		const { registry } = setup({
			name: "m",
			recipes: [
				{
					id: "gen",
					params: [
						{ name: "name", type: "string", required: true, description: "n" },
						{ name: "loud", type: "boolean", required: false, description: "l", default: false },
					],
					templates: { "{{name}}.txt.hbs": "x\n" },
					recipeTs: `export const genRecipe = { name: "x", execute: async () => ({ success: true, output: { made: 1 }, compensationData: { token: "t" } }), compensate: async () => {} }`,
					validators: ["report"],
				},
			],
			files: { "gen/validators/report.ts": validatorFile("report", REPORT) },
		})
		const result = await runRecipe({ registry, pack: "m", recipe: "gen", params: { name: "a" } })
		expect(JSON.parse(result.diagnostics[0]?.message ?? "{}")).toEqual({
			pack: "m",
			recipe: "gen",
			ran: true,
			params: { name: "a", loud: false },
			compensationData: { token: "t" },
			output: { made: 1 },
			changeset: ["a.txt:create"],
			detected: null,
		})
	})

	it("a template-only recipe's compensation data is { written }", async () => {
		const { registry } = setup({
			name: "m",
			recipes: [{ id: "gen", templates: OK_TEMPLATE, validators: ["report"] }],
			files: { "gen/validators/report.ts": validatorFile("report", REPORT) },
		})
		const result = await runRecipe({ registry, pack: "m", recipe: "gen", params: {} })
		expect(JSON.parse(result.diagnostics[0]?.message ?? "{}")).toMatchObject({
			compensationData: { written: ["out.txt"] },
			output: null,
		})
	})

	it("pack-level validators in a run see the run that triggered them", async () => {
		const { registry } = setup({
			name: "m",
			recipes: [{ id: "gen", templates: OK_TEMPLATE }],
			packValidators: ["report"],
			files: { "_shared/validators/report.ts": validatorFile("report", REPORT) },
		})
		const result = await runRecipe({ registry, pack: "m", recipe: "gen", params: {} })
		expect(JSON.parse(result.diagnostics[0]?.message ?? "{}")).toMatchObject({ recipe: "gen", ran: true })
	})
})

describe("which validators run", () => {
	function twoRecipes(extra: { markerA?: string[]; markerB?: string[] } = {}) {
		return setup({
			name: "m",
			recipes: [
				{ id: "a", templates: { "a.txt.hbs": "a\n" }, validators: ["checkA"], marker: extra.markerA },
				{ id: "b", templates: { "b.txt.hbs": "b\n" }, validators: ["checkB"], marker: extra.markerB },
			],
			packValidators: ["checkPack"],
			files: {
				"a/validators/check-a.ts": validatorFile(
					"checkA",
					`[{ severity: "warning", rule: "ra", message: JSON.stringify(state.run) }]`,
				),
				"b/validators/check-b.ts": validatorFile(
					"checkB",
					`[{ severity: "warning", rule: "rb", message: JSON.stringify(state.run) }]`,
				),
				"_shared/validators/check-pack.ts": validatorFile(
					"checkPack",
					`[{ severity: "warning", rule: "rm", message: String(state.run?.recipe ?? "none") }]`,
				),
			},
		})
	}

	it("a run runs its own recipe's validators and the pack's, not a sibling recipe's", async () => {
		const { registry } = twoRecipes()
		const result = await runRecipe({ registry, pack: "m", recipe: "a", params: {} })
		expect(result.diagnostics.map((d) => d.validator)).toEqual(["m:checkPack", "m.a:checkA"])
	})

	it("baka validate runs pack-level validators with no run, and no recipe validators without a marker", async () => {
		const { registry } = twoRecipes()
		await runRecipe({ registry, pack: "m", recipe: "a", params: {} })
		const result = await validate(registry)
		expect(result.valid).toBe(true)
		expect(result.validation.diagnostics.map((d) => [d.validator, d.message])).toEqual([["m:checkPack", "none"]])
	})

	it("baka validate runs a recipe's validators only when its marker matches, with ran: false and the detected paths", async () => {
		const { registry } = twoRecipes({ markerA: ["a.txt"], markerB: ["packages/**/b.txt"] })
		await runRecipe({ registry, pack: "m", recipe: "a", params: {} })
		const result = await validate(registry)
		const byValidator = Object.fromEntries(result.validation.diagnostics.map((d) => [d.validator, d.message]))
		expect(Object.keys(byValidator).sort()).toEqual(["m.a:checkA", "m:checkPack"])
		expect(JSON.parse(byValidator["m.a:checkA"] ?? "{}")).toEqual({
			pack: "m",
			recipe: "a",
			ran: false,
			params: {},
			compensationData: null,
			output: null,
			changeset: [],
			detected: ["a.txt"],
		})
	})

	it("a marker glob matches across directories with ** and within one with *", async () => {
		const { registry, root } = twoRecipes({ markerA: ["packages/*/package.json"], markerB: ["apps/**/b.txt"] })
		mkdirSync(join(root, "packages", "ui"), { recursive: true })
		writeFileSync(join(root, "packages", "ui", "package.json"), "{}")
		mkdirSync(join(root, "packages", "ui", "deep"), { recursive: true })
		writeFileSync(join(root, "packages", "ui", "deep", "package.json"), "{}")
		mkdirSync(join(root, "apps", "x", "y"), { recursive: true })
		writeFileSync(join(root, "apps", "x", "y", "b.txt"), "b")
		const result = await validate(registry)
		const detected = Object.fromEntries(
			result.validation.diagnostics
				.filter((d) => d.validator?.startsWith("m."))
				.map((d) => [d.validator, (JSON.parse(d.message) as { detected: string[] }).detected]),
		)
		expect(detected).toEqual({ "m.a:checkA": ["packages/ui/package.json"], "m.b:checkB": ["apps/x/y/b.txt"] })
	})

	it("validate({ pack }) limits project validation to one pack", async () => {
		const { registry } = twoRecipes()
		const result = await validate(registry, "m")
		expect(result.packName).toBe("m")
		await expect(validate(registry, "missing")).rejects.toThrow(/not found/)
	})
})

describe("a sibling pack's structural errors do not fail an unrelated run", () => {
	function withBrokenSibling() {
		const root = tempDir()
		const packs = tempDir()
		writePack(packs, { name: "good", recipes: [{ id: "gen", templates: OK_TEMPLATE }] })
		// declares a validator whose file does not exist: a `recipe-validator-missing` error at discovery
		writePack(packs, { name: "broken", recipes: [{ id: "gen", templates: OK_TEMPLATE, validators: ["ghost"] }] })
		writeFileSync(join(packs, "notamodule.txt"), "")
		return { root, registry: createRegistry({ root, packDirs: [packs] }) }
	}

	it("runs the good pack with a clean receipt", async () => {
		const { registry } = withBrokenSibling()
		const result = await runRecipe({ registry, pack: "good", recipe: "gen", params: {} })
		expect(result.ok).toBe(true)
		expect(result.diagnostics).toEqual([])
	})

	it("still fails the broken pack's own run, and a project-wide validate sees it", async () => {
		const { registry } = withBrokenSibling()
		const own = await runRecipe({ registry, pack: "broken", recipe: "gen", params: {} })
		expect(own.ok).toBe(false)
		expect(own.diagnostics.map((d) => d.rule)).toContain("recipe-validator-missing")
		const project = await validate(registry)
		expect(project.valid).toBe(false)
		expect((await validate(registry, "good")).valid).toBe(true)
	})
})
