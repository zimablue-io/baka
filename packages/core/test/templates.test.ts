import { createHash } from "node:crypto"
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compensateAction, createRegistry, runAction, TREE_HASH_DOMAIN } from "../src/index.js"
import { cleanupTempDirs, fakeProvider, tempDir, writeModule } from "./helpers.js"

afterEach(cleanupTempDirs)

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

interface Fixture {
	params?: Array<Record<string, unknown>>
	templates?: Record<string, string>
	actionTs?: string
	files?: Record<string, string>
	supportsDryRun?: boolean
}

function setup(fx: Fixture) {
	const root = tempDir()
	const modules = tempDir()
	writeModule(modules, {
		name: "t",
		actions: [
			{
				id: "gen",
				params: (fx.params ?? []) as never,
				templates: fx.templates,
				actionTs: fx.actionTs,
				supportsDryRun: fx.supportsDryRun,
			},
		],
		files: fx.files,
	})
	return { root, modules, registry: createRegistry({ root, moduleDirs: [modules] }) }
}

type Registry = ReturnType<typeof setup>["registry"]
const run = (registry: Registry, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
	runAction({ registry, module: "t", action: "gen", params, ...extra })

const files = (root: string) => readdirSync(root).sort()

const BOOL = (name: string) => ({ name, type: "boolean", required: false, description: name, default: false })

describe("conditional files", () => {
	const templates = {
		"always.txt.hbs": "always\n",
		"vitest.config.ts.hbs": '{{!-- @baka when="vitest" --}}\nexport default {}\n',
		"no-vitest.md.hbs": '{{!-- @baka when="!vitest" --}}no tests\n',
	}
	const params = [BOOL("vitest")]

	it("writes a file only when its `when` holds for the params, and the directive never reaches the output", async () => {
		const { root, registry } = setup({ params, templates })
		const on = await run(registry, { vitest: true })
		expect(on.changeset.map((e) => e.path)).toEqual(["always.txt", "vitest.config.ts"])
		expect(readFileSync(join(root, "vitest.config.ts"), "utf-8")).toBe("export default {}\n")

		const off = setup({ params, templates })
		const result = await run(off.registry, { vitest: false })
		expect(result.changeset.map((e) => e.path)).toEqual(["always.txt", "no-vitest.md"])
		expect(readFileSync(join(off.root, "no-vitest.md"), "utf-8")).toBe("no tests\n")
	})

	it("supports equality on enums and nested data, and truthiness like Handlebars if", async () => {
		const { registry } = setup({
			params: [
				{ name: "kind", type: "enum", required: true, description: "k", enumValues: ["lib", "app"] },
				{ name: "tags", type: "array", required: false, description: "t", items: { type: "string" }, default: [] },
			],
			files: { "data/features.json": '{"strict": true, "off": false}' },
			templates: {
				"lib.txt.hbs": '{{!-- @baka when="kind=lib" --}}lib\n',
				"app.txt.hbs": '{{!-- @baka when="kind!=lib" --}}app\n',
				"quoted.txt.hbs": "{{!-- @baka when=\"kind='app'\" --}}q\n",
				"tagged.txt.hbs": '{{!-- @baka when="tags" --}}tagged\n',
				"strict.txt.hbs": '{{!-- @baka when="data.features.strict" --}}strict\n',
				"off.txt.hbs": '{{!-- @baka when="data.features.off" --}}off\n',
				"missing.txt.hbs": '{{!-- @baka when="nothing.here" --}}missing\n',
			},
		})
		const lib = await run(registry, { kind: "lib" })
		expect(lib.changeset.map((e) => e.path)).toEqual(["lib.txt", "strict.txt"])
		const app = setup({
			params: [
				{ name: "kind", type: "enum", required: true, description: "k", enumValues: ["lib", "app"] },
				{ name: "tags", type: "array", required: false, description: "t", items: { type: "string" }, default: [] },
			],
			templates: {
				"app.txt.hbs": '{{!-- @baka when="kind!=lib" --}}app\n',
				"quoted.txt.hbs": "{{!-- @baka when=\"kind='app'\" --}}q\n",
				"tagged.txt.hbs": '{{!-- @baka when="tags" --}}tagged\n',
			},
		})
		const withTags = await run(app.registry, { kind: "app", tags: ["x"] })
		expect(withTags.changeset.map((e) => e.path)).toEqual(["app.txt", "quoted.txt", "tagged.txt"])
		const noTags = await run(
			setup({
				params: [
					{ name: "kind", type: "enum", required: true, description: "k", enumValues: ["app"] },
					{ name: "tags", type: "array", required: false, description: "t", items: { type: "string" }, default: [] },
				],
				templates: { "tagged.txt.hbs": '{{!-- @baka when="tags" --}}tagged\n' },
			}).registry,
			{ kind: "app" },
		)
		expect(noTags.changeset).toEqual([])
	})

	it("never fills the slots of a disabled template, so no model is asked", async () => {
		const { registry } = setup({
			params,
			templates: {
				"doc.md.hbs": '{{!-- @baka when="vitest" --}}{{#slot "intro" kind="prose"}}hint{{/slot}}\n',
				"x.txt.hbs": "x\n",
			},
		})
		const provider = fakeProvider()
		const off = await run(registry, { vitest: false }, { provider })
		expect(off.ok).toBe(true)
		expect(off.slots).toEqual([])
		expect(provider.calls).toHaveLength(0)
		const on = await run(registry, { vitest: true }, { provider })
		expect(on.slots).toHaveLength(1)
		expect(provider.calls).toHaveLength(1)
	})

	it("a rerun with the flag flipped leaves the earlier file alone and hashes only what the action owns now", async () => {
		const { registry } = setup({ params, templates })
		const first = await run(registry, { vitest: true })
		const second = await run(registry, { vitest: true })
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
	})

	it.each([
		['{{!-- @baka when="" --}}x', /when=""/],
		['{{!-- @baka when="a b c" --}}x', /not valid/],
		['{{!-- @baka when="!a=b" --}}x', /not valid/],
		['{{!-- @baka when="a" when="b" --}}x', /twice/],
		['{{!-- @baka color="red" --}}x', /unknown @baka directive key/],
		["{{!-- @baka when=a --}}x", /key="value"/],
		['{{!-- @baka when="a"', /not closed/],
		['x\n{{!-- @baka when="a" --}}', /first line/],
	])("rejects a malformed directive %s", async (source, message) => {
		const { registry } = setup({ templates: { "f.txt.hbs": source } })
		const result = await run(registry)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["template-invalid"])
		expect(result.diagnostics[0]?.message).toMatch(message)
	})
})

describe("file mode", () => {
	const SCRIPT = '{{!-- @baka mode="0755" --}}#!/bin/sh\necho hi\n'
	const modeOf = (path: string) => statSync(path).mode & 0o777

	it("writes the file with the declared permission bits and reports them", async () => {
		const { root, registry } = setup({ templates: { ".githooks/pre-commit.hbs": SCRIPT, "plain.txt.hbs": "p\n" } })
		const result = await run(registry)
		expect(modeOf(join(root, ".githooks", "pre-commit"))).toBe(0o755)
		expect(readFileSync(join(root, ".githooks", "pre-commit"), "utf-8")).toBe("#!/bin/sh\necho hi\n")
		expect(result.changeset).toEqual([
			{ path: ".githooks/pre-commit", op: "create", contentHash: sha("#!/bin/sh\necho hi\n"), mode: "0755" },
			{ path: "plain.txt", op: "create", contentHash: sha("p\n") },
		])
	})

	it("a mode is part of the tree hash, and a plain entry hashes exactly as before", async () => {
		const { registry } = setup({ templates: { "run.sh.hbs": SCRIPT, "plain.txt.hbs": "p\n" } })
		const result = await run(registry)
		expect(result.outputTreeHash).toBe(
			sha(
				`${TREE_HASH_DOMAIN}\nplain.txt\0${sha("p\n")}\nrun.sh\0${sha("#!/bin/sh\necho hi\n")}\0 0755\n`.replace(
					"\0 ",
					"\0",
				),
			),
		)
	})

	it("a rerun finds the file unchanged with the same hash", async () => {
		const { registry } = setup({ templates: { "run.sh.hbs": SCRIPT } })
		const first = await run(registry)
		const second = await run(registry)
		expect(second.changeset[0]).toMatchObject({ op: "unchanged", mode: "0755" })
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
	})

	it("identical bytes with other bits are skipped by default (reporting the actual bits) and fixed by overwrite, reversibly", async () => {
		const { root, registry } = setup({ templates: { "run.sh.hbs": SCRIPT } })
		writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho hi\n")
		chmodSync(join(root, "run.sh"), 0o644)

		const skipped = await run(registry)
		expect(skipped.changeset[0]).toMatchObject({ op: "skip", reason: "already-exists", mode: "0644" })
		expect(modeOf(join(root, "run.sh"))).toBe(0o644)

		const fixed = await run(registry, {}, { onExisting: "overwrite" })
		expect(fixed.changeset[0]).toMatchObject({ op: "update", mode: "0755" })
		expect(modeOf(join(root, "run.sh"))).toBe(0o755)
		expect(fixed.compensation.overwritten[0]).toMatchObject({ path: "run.sh", mode: "0644" })

		await compensateAction({ registry, module: "t", action: "gen", compensation: fixed.compensation })
		expect(modeOf(join(root, "run.sh"))).toBe(0o644)
	})

	it("rejects setuid/sticky bits and non-octal modes", async () => {
		for (const mode of ["4755", "1777", "rwx", "88", "75"]) {
			const { registry } = setup({ templates: { "f.sh.hbs": `{{!-- @baka mode="${mode}" --}}x\n` } })
			expect((await run(registry)).diagnostics.map((d) => d.rule)).toEqual(["template-invalid"])
		}
	})

	it("ctx.files.write takes a mode too", async () => {
		const { root, registry } = setup({
			actionTs: `export const genAction = { name: "x", execute: async (_i, _s, ctx) => {
				const w = ctx.files.write("bin/tool", "#!/bin/sh\\n", { mode: "755" })
				return { success: true, output: w, compensationData: null }
			}, compensate: async () => {} }`,
		})
		const first = await run(registry)
		expect(first.output).toMatchObject({ op: "create", mode: "0755" })
		expect(modeOf(join(root, "bin", "tool"))).toBe(0o755)
		expect(first.changeset).toEqual([{ path: "bin/tool", op: "create", contentHash: sha("#!/bin/sh\n"), mode: "0755" }])
		const second = await run(registry)
		expect(second.changeset[0]).toMatchObject({ op: "unchanged", mode: "0755" })
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
	})

	it("a dry run reports the mode without touching the disk", async () => {
		const { root, registry } = setup({ templates: { "run.sh.hbs": SCRIPT } })
		const dry = await run(registry, {}, { dryRun: true })
		expect(dry.changeset[0]).toMatchObject({ mode: "0755" })
		expect(existsSync(join(root, "run.sh"))).toBe(false)
		expect((await run(registry)).outputTreeHash).toBe(dry.outputTreeHash)
	})
})

describe("literal braces", () => {
	it("\\{{ renders a literal {{ so generated code can contain braces", async () => {
		const { root, registry } = setup({
			params: [{ name: "name", type: "string", required: true, description: "n" }],
			templates: {
				"a.tsx.hbs":
					"const x = <Foo style=\\{{ color: '{{name}}' }} />\nconst t = `\\{{word}}` // \\{{not a helper arg}}\n",
			},
		})
		const result = await run(registry, { name: "red" })
		expect(result.ok).toBe(true)
		expect(readFileSync(join(root, "a.tsx"), "utf-8")).toBe(
			"const x = <Foo style={{ color: 'red' }} />\nconst t = `{{word}}` // {{not a helper arg}}\n",
		)
	})

	it("two escapes in a row, and a doubled backslash that is not an escape", async () => {
		const { root, registry } = setup({
			params: [{ name: "name", type: "string", required: true, description: "n" }],
			templates: { "a.txt.hbs": "\\{{\\{{ \\\\{{name}}\n" },
		})
		await run(registry, { name: "N" })
		expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("{{{{ \\N\n")
	})

	it("a param value or slot fill containing {{ stays literal and is never evaluated", async () => {
		const { root, registry } = setup({
			params: [{ name: "name", type: "string", required: true, description: "n" }],
			templates: { "a.md.hbs": '{{name}}\n{{#slot "s" kind="prose"}}hint{{/slot}}\n' },
		})
		const result = await run(
			registry,
			{ name: "{{#each x}}{{name}}" },
			{ provider: fakeProvider("fill {{name}} and {{{x}}}") },
		)
		expect(result.ok).toBe(true)
		expect(readFileSync(join(root, "a.md"), "utf-8")).toBe("{{#each x}}{{name}}\nfill {{name}} and {{{x}}}\n")
	})
})

describe("JSON escaping", () => {
	it("{{json x}} emits a JSON literal and {{jsonEscape x}} the escaped body of a JSON string", async () => {
		const { root, registry } = setup({
			params: [
				{ name: "name", type: "string", required: true, description: "n" },
				{ name: "tags", type: "array", required: false, description: "t", items: { type: "string" }, default: [] },
				{ name: "count", type: "number", required: false, description: "c", default: 3 },
			],
			templates: {
				"package.json.hbs":
					'{\n  "name": {{json name}},\n  "description": "Package for {{jsonEscape name}}",\n  "tags": {{json tags}},\n  "count": {{json count}}\n}\n',
			},
		})
		const name = 'He said "hi"\n\\ and <b>&'
		await run(registry, { name, tags: ["a", 'b"c'] })
		const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))
		expect(parsed).toEqual({ name, description: `Package for ${name}`, tags: ["a", 'b"c'], count: 3 })
	})
})

describe("the subset stays strict and fails closed", () => {
	const PARAMS = [{ name: "x", type: "string", required: false, description: "x", default: "v" }]

	it.each([
		["{{{x}}}", /triple-stash/],
		["{{&x}}", /triple-stash/],
		["{{> partial}}", /partials/],
		["{{#> partial}}x{{/partial}}", /partials/],
		["{{upper x}}", /custom helper/],
		["{{#with x}}y{{/with}}", /block helper \{\{#with\}\}/],
		["{{#unless x}}y{{/unless}}", /block helper \{\{#unless\}\}/],
		["{{lookup x 'y'}}", /custom helper/],
		["{{#each x as |y|}}{{y}}{{/each}}", /block params/],
		["{{#if (x)}}y{{/if}}", /plain parameter name/],
		["{{#if x y}}y{{/if}}", /exactly one parameter/],
		["{{#each x foo=1}}y{{/each}}", /no options/],
		["{{json}}", /exactly one parameter/],
		["{{json x y}}", /exactly one parameter/],
		["{{json (x)}}", /plain parameter name/],
		['{{json "literal"}}', /plain parameter name/],
		["{{x y=1}}", /custom helper/],
		['{{"x"}}', /plain parameter name/],
		["{{{{raw}}}}x{{{{/raw}}}}", /block helper \{\{#raw\}\}/],
		["{{#custom x}}y{{/custom}}", /block helper \{\{#custom\}\}/],
		["{{#if x}}y", /not valid Handlebars/],
		["{{#slot 'a'}}x{{/slot}}", /quoted id/],
		['{{#slot "a" bogus="1"}}x{{/slot}}', /not allowed/],
	])("rejects %s", async (source, message) => {
		const { root, registry } = setup({ params: PARAMS, templates: { "f.txt.hbs": source } })
		const result = await run(registry)
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["template-invalid"])
		expect(result.diagnostics[0]?.message).toMatch(message)
		expect(files(root)).toEqual([])
	})

	it("also checks the template's path", async () => {
		const { registry } = setup({ params: PARAMS, templates: { "{{upper x}}/f.txt.hbs": "x" } })
		const result = await run(registry)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["template-invalid"])
	})

	it("still allows params, if/else, each with @index and this, comments, and whitespace control", async () => {
		const { root, registry } = setup({
			params: [
				{ name: "ok", type: "boolean", required: false, description: "o", default: true },
				{
					name: "items",
					type: "array",
					required: false,
					description: "i",
					items: { type: "string" },
					default: ["a", "b"],
				},
				{ name: "x", type: "string", required: false, description: "x", default: "v" },
			],
			templates: {
				"f.txt.hbs":
					"{{!-- note --}}{{#if ok}}yes {{x}}{{else}}no{{/if}}\n{{#each items}}{{@index}}={{this}}{{#if @last}}.{{else}},{{/if}}{{/each}}\n{{~x~}}\n",
			},
		})
		await run(registry)
		expect(readFileSync(join(root, "f.txt"), "utf-8")).toBe("yes v\n0=a,1=b.v")
	})

	it("built-in helpers other than if and each are not callable even without arguments", async () => {
		const { root, registry } = setup({ templates: { "f.txt.hbs": "[{{log}}][{{lookup}}]\n" } })
		await run(registry)
		expect(readFileSync(join(root, "f.txt"), "utf-8")).toBe("[][]\n")
	})
})

describe("module data files", () => {
	const VERSIONS = JSON.stringify({ pnpm: "11.28.3", biome: { core: "2.5.15" }, list: ["a", "b"] })

	it("exposes data/*.json to templates as data.<name>", async () => {
		const { root, registry } = setup({
			files: {
				"data/versions.json": VERSIONS,
				"data/extra-pins.json": '{"x": 1}',
				"data/notes.txt": "ignored",
				"data/sub/nested.json": "{}",
			},
			templates: {
				"pins.txt.hbs":
					"pnpm {{data.versions.pnpm}} biome {{data.versions.biome.core}} x {{data.extra-pins.x}}\n{{#each data.versions.list}}{{this}} {{/each}}\n",
			},
		})
		const result = await run(registry)
		expect(result.ok).toBe(true)
		expect(readFileSync(join(root, "pins.txt"), "utf-8")).toBe("pnpm 11.28.3 biome 2.5.15 x 1\na b \n")
	})

	it("exposes it to action.ts as ctx.data, read-only", async () => {
		const { registry } = setup({
			files: { "data/versions.json": VERSIONS },
			actionTs: `export const genAction = { name: "x", execute: async (_i, _s, ctx) => {
				let threw = false
				try { ctx.data.versions.pnpm = "hacked" } catch { threw = true }
				let threwDeep = false
				try { ctx.data.versions.list.push("c") } catch { threwDeep = true }
				return { success: true, output: { pnpm: ctx.data.versions.pnpm, keys: Object.keys(ctx.data), threw, threwDeep, frozen: Object.isFrozen(ctx.data) }, compensationData: null }
			}, compensate: async () => {} }`,
		})
		const result = await run(registry)
		expect(result.output).toEqual({ pnpm: "11.28.3", keys: ["versions"], threw: true, threwDeep: true, frozen: true })
	})

	it("is empty for a module without data/", async () => {
		const { registry } = setup({
			actionTs: `export const genAction = { name: "x", execute: async (_i, _s, ctx) => ({ success: true, output: Object.keys(ctx.data), compensationData: null }), compensate: async () => {} }`,
		})
		expect((await run(registry)).output).toEqual([])
	})

	it("is part of the module pin, so a lockfile covers it", async () => {
		const a = setup({ files: { "data/versions.json": '{"v":1}' }, templates: { "o.txt.hbs": "{{data.versions.v}}\n" } })
		const b = setup({ files: { "data/versions.json": '{"v":2}' }, templates: { "o.txt.hbs": "{{data.versions.v}}\n" } })
		const ra = await run(a.registry)
		const rb = await run(b.registry)
		expect(ra.pins[0]?.contentHash).not.toBe(rb.pins[0]?.contentHash)
		expect(ra.outputTreeHash).not.toBe(rb.outputTreeHash)
	})

	it("fails the module with module-invalid on a data file that is not JSON", async () => {
		const { root, registry } = setup({ files: { "data/bad.json": "{nope" }, templates: { "o.txt.hbs": "x\n" } })
		const result = await run(registry)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["module-invalid"])
		expect(result.diagnostics[0]?.message).toContain("data/bad.json")
		expect(files(root)).toEqual([])
	})

	it("reserves `data` as a param name", async () => {
		const { registry } = setup({
			params: [{ name: "data", type: "string", required: false, description: "d" }],
			templates: { "o.txt.hbs": "x\n" },
		})
		const result = await run(registry)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["module-invalid"])
		expect(result.diagnostics[0]?.message).toContain("reserved")
	})
})
