import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compensateRecipe, createRegistry, runRecipe } from "../src/index.js"
import { cleanupTempDirs, fakeProvider, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

// Two templates, one slot, so a run can have a mix of existing and new targets.
function setup() {
	const root = tempDir()
	const packs = tempDir()
	writePack(packs, {
		name: "docs",
		recipes: [
			{
				id: "page",
				params: [{ name: "title", type: "string", required: true, description: "title" }],
				templates: {
					"README.md.hbs": '# {{title}}\n{{#slot "intro" kind="prose" max=80}}intro{{/slot}}\n',
					"docs/{{title}}.md.hbs": "about {{title}}\n",
				},
			},
		],
	})
	return { root, registry: createRegistry({ root, packDirs: [packs] }) }
}

const RUN = { pack: "docs", recipe: "page", params: { title: "Alpha" } }
const README = "# Alpha\nHello.\n"

function ops(result: { changeset: Array<{ path: string; op: string }> }): Record<string, string> {
	return Object.fromEntries(result.changeset.map((e) => [e.path, e.op]))
}

describe("onExisting: skip (the default)", () => {
	it("leaves a differing file alone and says so, so 'nothing happened' is distinguishable from 'same tree'", async () => {
		const { root, registry } = setup()
		const fresh = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hello.") })
		expect(ops(fresh)).toEqual({ "README.md": "create", "docs/Alpha.md": "create" })

		writeFileSync(join(root, "README.md"), "# my own readme\n")
		const rerun = await runRecipe({ registry, ...RUN })
		expect(rerun.ok).toBe(true)
		expect(ops(rerun)).toEqual({ "README.md": "skip", "docs/Alpha.md": "unchanged" })
		expect(rerun.changeset.find((e) => e.path === "README.md")).toMatchObject({
			reason: "already-exists",
			contentHash: sha("# my own readme\n"),
		})
		expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("# my own readme\n")
		// The skipped file's bytes are not what the templates produce, so this is not the same tree.
		expect(rerun.outputTreeHash).not.toBe(fresh.outputTreeHash)
		expect(rerun.compensation).toMatchObject({ created: [], overwritten: [] })
	})

	it("reports every file as unchanged, with the original tree hash, when nothing differs", async () => {
		const { registry } = setup()
		const fresh = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hello.") })
		const rerun = await runRecipe({ registry, ...RUN })
		expect(ops(rerun)).toEqual({ "README.md": "unchanged", "docs/Alpha.md": "unchanged" })
		expect(rerun.outputTreeHash).toBe(fresh.outputTreeHash)
	})
})

describe("onExisting: overwrite", () => {
	it("rewrites a differing file as an update and reaches the same tree as a fresh run", async () => {
		const fresh = setup()
		const freshResult = await runRecipe({ registry: fresh.registry, ...RUN, provider: fakeProvider("Hello.") })

		const { root, registry } = setup()
		mkdirSync(join(root, "docs"))
		writeFileSync(join(root, "README.md"), "# stale\n")
		const result = await runRecipe({
			registry,
			...RUN,
			provider: fakeProvider("Hello."),
			onExisting: "overwrite",
		})
		expect(result.ok).toBe(true)
		expect(ops(result)).toEqual({ "README.md": "update", "docs/Alpha.md": "create" })
		expect(readFileSync(join(root, "README.md"), "utf-8")).toBe(README)
		expect(result.changeset.find((e) => e.path === "README.md")?.contentHash).toBe(sha(README))
		expect(result.outputTreeHash).toBe(freshResult.outputTreeHash)
	})

	it("does not touch a file that already holds the right bytes", async () => {
		const { registry } = setup()
		await runRecipe({ registry, ...RUN, provider: fakeProvider("Hello.") })
		const again = await runRecipe({ registry, ...RUN, onExisting: "overwrite" })
		expect(ops(again)).toEqual({ "README.md": "unchanged", "docs/Alpha.md": "unchanged" })
		expect(again.compensation.overwritten).toEqual([])
	})

	it("records the previous bytes so compensation restores them", async () => {
		const { root, registry } = setup()
		mkdirSync(join(root, "docs"))
		writeFileSync(join(root, "README.md"), "# keep me\n")
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hello."), onExisting: "overwrite" })
		expect(result.compensation.created).toEqual(["docs/Alpha.md"])
		expect(result.compensation.overwritten).toEqual([
			{ path: "README.md", contentBase64: Buffer.from("# keep me\n").toString("base64") },
		])

		await compensateRecipe({ registry, pack: "docs", recipe: "page", compensation: result.compensation })
		expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("# keep me\n")
		expect(readdirSync(join(root, "docs"))).toEqual([])
	})

	it("dry run reports the update without touching the file", async () => {
		const { root, registry } = setup()
		writeFileSync(join(root, "README.md"), "# stale\n")
		const result = await runRecipe({
			registry,
			...RUN,
			provider: fakeProvider("Hello."),
			onExisting: "overwrite",
			dryRun: true,
		})
		expect(ops(result)).toEqual({ "README.md": "update", "docs/Alpha.md": "create" })
		expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("# stale\n")
		expect(readdirSync(root).sort()).toEqual(["README.md"])
	})
})

describe("onExisting: fail", () => {
	it("refuses the whole run before any model call or write, naming every existing target", async () => {
		const { root, registry } = setup()
		mkdirSync(join(root, "docs"))
		writeFileSync(join(root, "README.md"), "mine\n")
		writeFileSync(join(root, "docs", "Alpha.md"), "mine too\n")
		const provider = fakeProvider()
		const result = await runRecipe({ registry, ...RUN, provider, onExisting: "fail" })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["target-exists"])
		expect(result.diagnostics[0]?.message).toContain("README.md")
		expect(result.diagnostics[0]?.message).toContain("docs/Alpha.md")
		expect(provider.calls).toHaveLength(0)
		expect(result.changeset).toEqual([])
		expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("mine\n")
	})

	it("runs normally when no target exists", async () => {
		const { registry } = setup()
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hello."), onExisting: "fail" })
		expect(result.ok).toBe(true)
		expect(ops(result)).toEqual({ "README.md": "create", "docs/Alpha.md": "create" })
	})

	it("fails on an existing target even when its content is identical, and a dry run predicts the failure", async () => {
		const { registry } = setup()
		await runRecipe({ registry, ...RUN, provider: fakeProvider("Hello.") })
		const result = await runRecipe({ registry, ...RUN, onExisting: "fail", dryRun: true })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["target-exists"])
	})
})

describe("targets that are not regular files", () => {
	it("is a template-invalid failure that writes nothing, whatever the policy", async () => {
		const { root, registry } = setup()
		mkdirSync(join(root, "README.md")) // a directory where the template wants a file
		const result = await runRecipe({ registry, ...RUN, provider: fakeProvider("Hello."), onExisting: "overwrite" })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["template-invalid"])
		expect(readdirSync(root)).toEqual(["README.md"])
	})

	it("rejects two templates that render to the same path, before any model call", async () => {
		const root = tempDir()
		const packs = tempDir()
		writePack(packs, {
			name: "dup",
			recipes: [
				{
					id: "x",
					params: [{ name: "n", type: "string", required: true, description: "n" }],
					templates: { "{{n}}.txt.hbs": "a\n", "same.txt.hbs": "b\n" },
				},
			],
		})
		const registry = createRegistry({ root, packDirs: [packs] })
		const result = await runRecipe({ registry, pack: "dup", recipe: "x", params: { n: "same" } })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["template-invalid"])
		expect(result.diagnostics[0]?.message).toContain("same.txt")
		expect(readdirSync(root)).toEqual([])
	})
})
