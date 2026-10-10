import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compensateRecipe, createRegistry, runRecipe } from "../src/index.js"
import { cleanupTempDirs, tempDir, writePack } from "./helpers.js"

afterEach(cleanupTempDirs)

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

interface Fixture {
	/** Source of recipe.ts. */
	recipeTs: string
	supportsDryRun?: boolean
	templates?: Record<string, string>
}

function setup(fx: Fixture) {
	const base = tempDir()
	const root = join(base, "project")
	mkdirSync(root)
	const packs = tempDir()
	writePack(packs, {
		name: "fx",
		recipes: [
			{
				id: "gen",
				params: [{ name: "name", type: "string", required: false, description: "n", default: "pkg" }],
				recipeTs: fx.recipeTs,
				supportsDryRun: fx.supportsDryRun,
				templates: fx.templates,
			},
		],
	})
	return { base, root, registry: createRegistry({ root, packDirs: [packs] }) }
}

type Registry = ReturnType<typeof setup>["registry"]
const run = (registry: Registry, extra: Record<string, unknown> = {}) =>
	runRecipe({ registry, pack: "fx", recipe: "gen", params: {}, ...extra })

const ops = (r: { changeset: Array<{ path: string; op: string }> }) =>
	Object.fromEntries(r.changeset.map((e) => [e.path, e.op]))

/** Writes two files through ctx.files and returns what each write reported. */
const WRITER = `
export const genRecipe = {
	name: "fx.gen",
	execute: async (input, _state, ctx) => {
		const a = ctx.files.write("pkg/package.json", '{"name":"' + input.name + '"}\\n')
		const b = ctx.files.write("pkg/src/index.ts", "export {}\\n")
		return { success: true, output: { a, b }, compensationData: { made: [a.path, b.path] } }
	},
	compensate: async () => {},
}
`

describe("the recipe.ts context", () => {
	it("hands execute the run's onExisting, dryRun, pack, project root and a files API", async () => {
		const { root, registry } = setup({
			recipeTs: `
export const genRecipe = {
	name: "fx.gen",
	execute: async (_input, state, ctx) => ({
		success: true,
		compensationData: null,
		output: {
			onExisting: ctx.onExisting,
			dryRun: ctx.dryRun,
			pack: { name: ctx.pack.name, version: ctx.pack.version, hasRoot: typeof ctx.pack.root === "string" },
			projectRoot: ctx.projectRoot,
			sameAsState: ctx.projectRoot === state.targetDirectory,
			files: Object.keys(ctx.files).sort(),
			provider: ctx.llmProvider,
		},
	}),
	compensate: async () => {},
}`,
		})
		const result = await run(registry, { onExisting: "overwrite" })
		expect(result.ok).toBe(true)
		expect(result.output).toEqual({
			onExisting: "overwrite",
			dryRun: false,
			pack: { name: "fx", version: "0.1.0", hasRoot: true },
			projectRoot: registry.root,
			sameAsState: true,
			files: ["exists", "own", "readText", "remove", "write"],
			provider: null,
		})
		expect(registry.root).toBe(root)
	})

	it("defaults onExisting to skip", async () => {
		const { registry } = setup({
			recipeTs: `export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => ({ success: true, output: ctx.onExisting, compensationData: null }), compensate: async () => {} }`,
		})
		expect((await run(registry)).output).toBe("skip")
	})
})

describe("ctx.files writes", () => {
	it("create, then a rerun reports every file unchanged and hashes the same tree", async () => {
		const { registry } = setup({ recipeTs: WRITER })
		const first = await run(registry)
		expect(first.ok).toBe(true)
		expect(ops(first)).toEqual({ "pkg/package.json": "create", "pkg/src/index.ts": "create" })
		expect(first.compensation.created).toEqual(["pkg/package.json", "pkg/src/index.ts"])
		expect(first.compensation.createdDirs).toEqual(["pkg", "pkg/src"])

		const second = await run(registry)
		expect(second.ok).toBe(true)
		expect(second.changeset).toEqual([
			{ path: "pkg/package.json", op: "unchanged", contentHash: sha('{"name":"pkg"}\n'), reason: "identical" },
			{ path: "pkg/src/index.ts", op: "unchanged", contentHash: sha("export {}\n"), reason: "identical" },
		])
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
		expect(second.compensation.created).toEqual([])
	})

	it("honours onExisting: skip leaves other bytes alone and reports skip", async () => {
		const { root, registry } = setup({ recipeTs: WRITER })
		await run(registry)
		writeFileSync(join(root, "pkg", "package.json"), "mine\n")
		const result = await run(registry)
		expect(ops(result)).toEqual({ "pkg/package.json": "skip", "pkg/src/index.ts": "unchanged" })
		expect(result.changeset[0]).toMatchObject({ reason: "already-exists", contentHash: sha("mine\n") })
		expect(readFileSync(join(root, "pkg", "package.json"), "utf-8")).toBe("mine\n")
	})

	it("honours onExisting: overwrite rewrites it, reports update, and converges on the first run's tree", async () => {
		const { root, registry } = setup({ recipeTs: WRITER })
		const first = await run(registry)
		writeFileSync(join(root, "pkg", "package.json"), "mine\n")
		const result = await run(registry, { onExisting: "overwrite" })
		expect(ops(result)).toEqual({ "pkg/package.json": "update", "pkg/src/index.ts": "unchanged" })
		expect(result.outputTreeHash).toBe(first.outputTreeHash)
		expect(result.compensation.overwritten).toEqual([
			{ path: "pkg/package.json", contentBase64: Buffer.from("mine\n").toString("base64") },
		])
		await compensateRecipe({ registry, pack: "fx", recipe: "gen", compensation: result.compensation })
		expect(readFileSync(join(root, "pkg", "package.json"), "utf-8")).toBe("mine\n")
	})

	it("honours onExisting: fail by failing the run with target-exists and undoing the rest", async () => {
		const { root, registry } = setup({ recipeTs: WRITER })
		mkdirSync(join(root, "pkg", "src"), { recursive: true })
		writeFileSync(join(root, "pkg", "src", "index.ts"), "mine\n")
		const result = await run(registry, { onExisting: "fail" })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["target-exists"])
		// package.json was written before index.ts was refused; the engine took it back.
		expect(existsSync(join(root, "pkg", "package.json"))).toBe(false)
		expect(readFileSync(join(root, "pkg", "src", "index.ts"), "utf-8")).toBe("mine\n")
	})

	it("an explicit per-file onExisting overrides the run's", async () => {
		const { root, registry } = setup({
			recipeTs: `export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => ({ success: true, output: ctx.files.write("a.txt", "new", { onExisting: "overwrite" }).op, compensationData: null }), compensate: async () => {} }`,
		})
		writeFileSync(join(root, "a.txt"), "old")
		const result = await run(registry)
		expect(result.output).toBe("update")
		expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("new")
	})

	it("exists, readText and remove see the files written so far; a removal is a delete", async () => {
		const { root, registry } = setup({
			recipeTs: `export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => {
				const before = ctx.files.exists("note.txt")
				ctx.files.write("note.txt", "hello")
				const text = ctx.files.readText("note.txt")
				const removed = ctx.files.remove("old.txt")
				const missing = ctx.files.remove("never.txt")
				return { success: true, output: { before, text, removed, missing, after: ctx.files.exists("old.txt") }, compensationData: null }
			}, compensate: async () => {} }`,
		})
		writeFileSync(join(root, "old.txt"), "old")
		const result = await run(registry)
		expect(result.output).toEqual({ before: false, text: "hello", removed: true, missing: false, after: false })
		expect(result.changeset).toEqual([
			{ path: "note.txt", op: "create", contentHash: sha("hello") },
			{ path: "old.txt", op: "delete", contentHash: null },
		])
		await compensateRecipe({ registry, pack: "fx", recipe: "gen", compensation: result.compensation })
		expect(readFileSync(join(root, "old.txt"), "utf-8")).toBe("old")
		expect(existsSync(join(root, "note.txt"))).toBe(false)
	})

	it("a file written twice in one run is one create with the final hash", async () => {
		const { registry } = setup({
			recipeTs: `export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => {
				ctx.files.write("a.txt", "one")
				ctx.files.write("a.txt", "two", { onExisting: "overwrite" })
				return { success: true, output: null, compensationData: null }
			}, compensate: async () => {} }`,
		})
		const result = await run(registry)
		expect(result.changeset).toEqual([{ path: "a.txt", op: "create", contentHash: sha("two") }])
	})

	it("writes binary content", async () => {
		const { root, registry } = setup({
			recipeTs: `export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => {
				ctx.files.write("bin.dat", new Uint8Array([0, 255, 1]))
				return { success: true, output: null, compensationData: null }
			}, compensate: async () => {} }`,
		})
		await run(registry)
		expect([...readFileSync(join(root, "bin.dat"))]).toEqual([0, 255, 1])
	})
})

describe("ctx.files is contained", () => {
	const attempt = (call: string) =>
		`export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => { ${call}; return { success: true, output: null, compensationData: null } }, compensate: async () => {} }`

	it.each([
		['ctx.files.write("../escaped.txt", "x")'],
		['ctx.files.write("/tmp/baka-abs-escape.txt", "x")'],
		['ctx.files.write("a/../../escaped.txt", "x")'],
		['ctx.files.write(".git/hooks/pre-commit", "x")'],
		['ctx.files.write(".baka/packs/evil/manifest.ts", "x")'],
		['ctx.files.exists("../outside")'],
		['ctx.files.readText("../outside")'],
		['ctx.files.remove("../outside")'],
		['ctx.files.own("../outside")'],
	])("%s fails the run with path-escape and leaves nothing outside", async (call) => {
		const { base, root, registry } = setup({ recipeTs: attempt(call) })
		writeFileSync(join(base, "outside"), "keep me")
		const result = await run(registry)
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(readdirSync(base).sort()).toEqual(["outside", "project"])
		expect(readFileSync(join(base, "outside"), "utf-8")).toBe("keep me")
		expect(readdirSync(root)).toEqual([])
	})

	it("refuses a write through a symlink that points outside, undoing the writes before it", async () => {
		const { base, root, registry } = setup({
			recipeTs: attempt('ctx.files.write("ok/first.txt", "1"); ctx.files.write("link/second.txt", "2")'),
		})
		const outside = join(base, "outside")
		mkdirSync(outside)
		symlinkSync(outside, join(root, "link"))
		const result = await run(registry)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["path-escape"])
		expect(readdirSync(outside)).toEqual([])
		expect(existsSync(join(root, "ok"))).toBe(false)
	})
})

describe("a failed recipe.ts is compensated by the engine", () => {
	it("removes ctx.files writes, template files and every directory created, then calls the recipe's compensate", async () => {
		const { root, registry } = setup({
			templates: { "docs/deep/a.md.hbs": "a\n" },
			recipeTs: `
import { writeFileSync } from "node:fs"
import { join } from "node:path"
export const genRecipe = {
	name: "x",
	execute: async (_i, state, ctx) => {
		ctx.files.write("via/api/b.txt", "b")
		writeFileSync(join(state.targetDirectory, "plain.txt"), "p")
		return { success: false, output: null, compensationData: { marker: "m" }, error: "stop here" }
	},
	compensate: async (data, state) => {
		writeFileSync(join(state.targetDirectory, "compensated-" + data.marker + ".log"), "called")
	},
}`,
		})
		const result = await run(registry)
		expect(result.ok).toBe(false)
		expect(result.diagnostics).toEqual([{ severity: "error", rule: "recipe-failed", message: "stop here" }])
		expect(result.changeset).toEqual([])
		// everything gone, directories included; only what the recipe's own compensate wrote remains
		expect(readdirSync(root).sort()).toEqual(["compensated-m.log"])
	})

	it("also handles an execute that throws", async () => {
		const { root, registry } = setup({
			recipeTs: `
import { writeFileSync } from "node:fs"
import { join } from "node:path"
export const genRecipe = {
	name: "x",
	execute: async (_i, state, ctx) => {
		ctx.files.write("a/b/c.txt", "c")
		writeFileSync(join(state.targetDirectory, "a", "plain.txt"), "p")
		throw new Error("kaboom")
	},
	compensate: async () => { throw new Error("must not be called without data") },
}`,
		})
		const result = await run(registry)
		expect(result.diagnostics).toEqual([{ severity: "error", rule: "recipe-failed", message: "kaboom" }])
		expect(readdirSync(root)).toEqual([])
	})

	it("restores a file overwritten through ctx.files, and warns about one changed behind its back", async () => {
		const { root, registry } = setup({
			recipeTs: `
import { writeFileSync } from "node:fs"
import { join } from "node:path"
export const genRecipe = {
	name: "x",
	execute: async (_i, state, ctx) => {
		ctx.files.write("api.txt", "new", { onExisting: "overwrite" })
		writeFileSync(join(state.targetDirectory, "plain.txt"), "clobbered")
		throw new Error("late failure")
	},
	compensate: async () => {},
}`,
		})
		writeFileSync(join(root, "api.txt"), "old api")
		writeFileSync(join(root, "plain.txt"), "old plain")
		const result = await run(registry)
		expect(result.ok).toBe(false)
		expect(readFileSync(join(root, "api.txt"), "utf-8")).toBe("old api")
		expect(readFileSync(join(root, "plain.txt"), "utf-8")).toBe("clobbered")
		expect(result.diagnostics.map((d) => [d.severity, d.rule])).toEqual([
			["warning", "rollback-incomplete"],
			["error", "recipe-failed"],
		])
		expect(result.diagnostics[0]?.message).toContain("plain.txt")
	})

	it("a successful run's receipt also lists files written with plain fs, so compensateRecipe removes them", async () => {
		const { root, registry } = setup({
			recipeTs: `
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
export const genRecipe = {
	name: "x",
	execute: async (_i, state) => {
		mkdirSync(join(state.targetDirectory, "made", "dir"), { recursive: true })
		writeFileSync(join(state.targetDirectory, "made", "dir", "f.txt"), "f")
		return { success: true, output: null, compensationData: { note: 1 } }
	},
	compensate: async () => {},
}`,
		})
		const result = await run(registry)
		expect(result.compensation.created).toEqual(["made/dir/f.txt"])
		expect(result.compensation.createdDirs).toEqual(["made", "made/dir"])
		await compensateRecipe({ registry, pack: "fx", recipe: "gen", compensation: result.compensation })
		expect(readdirSync(root)).toEqual([])
	})
})

describe("ctx.files.own and the rerun hash", () => {
	const PLAIN_WRITER = `
import { writeFileSync } from "node:fs"
import { join } from "node:path"
export const genRecipe = {
	name: "x",
	execute: async (_i, state, ctx) => {
		writeFileSync(join(state.targetDirectory, "made.txt"), "made")
		OWN
		return { success: true, output: null, compensationData: null }
	},
	compensate: async () => {},
}`

	it("without own, a plain-fs write is only visible when it changes (the rerun's changeset is empty)", async () => {
		const { registry } = setup({ recipeTs: PLAIN_WRITER.replace("OWN", "") })
		const first = await run(registry)
		const second = await run(registry)
		expect(ops(first)).toEqual({ "made.txt": "create" })
		expect(second.changeset).toEqual([])
		expect(second.outputTreeHash).not.toBe(first.outputTreeHash)
	})

	it("with own, the rerun lists the file as unchanged and hashes the same", async () => {
		const { registry } = setup({ recipeTs: PLAIN_WRITER.replace("OWN", 'ctx.files.own("made.txt")') })
		const first = await run(registry)
		const second = await run(registry)
		expect(ops(first)).toEqual({ "made.txt": "create" })
		expect(ops(second)).toEqual({ "made.txt": "unchanged" })
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
	})

	it("templates and ctx.files together: first run and rerun hash the same owned set", async () => {
		const { registry } = setup({ recipeTs: WRITER, templates: { "README.md.hbs": "# {{name}}\n" } })
		const first = await run(registry)
		const second = await run(registry)
		expect(ops(first)).toEqual({ "README.md": "create", "pkg/package.json": "create", "pkg/src/index.ts": "create" })
		expect(ops(second)).toEqual({
			"README.md": "unchanged",
			"pkg/package.json": "unchanged",
			"pkg/src/index.ts": "unchanged",
		})
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
	})

	it("a recipe that rewrites a file its template produced keeps the template's create and takes the final hash", async () => {
		const { root, registry } = setup({
			templates: { "out.txt.hbs": "from template\n" },
			recipeTs: `export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => { ctx.files.write("out.txt", "from recipe\\n", { onExisting: "overwrite" }); return { success: true, output: null, compensationData: null } }, compensate: async () => {} }`,
		})
		const result = await run(registry)
		expect(result.changeset).toEqual([{ path: "out.txt", op: "create", contentHash: sha("from recipe\n") }])
		expect(readFileSync(join(root, "out.txt"), "utf-8")).toBe("from recipe\n")
	})
})

describe("dry run with a recipe.ts", () => {
	it("is refused unless the manifest declares supportsDryRun", async () => {
		const { root, registry } = setup({ recipeTs: WRITER })
		const result = await run(registry, { dryRun: true })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["dry-run-unsupported"])
		expect(readdirSync(root)).toEqual([])
	})

	it("runs against a virtual tree, writes nothing, and predicts the real run's changeset and hash", async () => {
		const { root, registry } = setup({
			recipeTs: WRITER,
			supportsDryRun: true,
			templates: { "README.md.hbs": "# {{name}}\n" },
		})
		const dry = await run(registry, { dryRun: true, includeContent: true })
		expect(dry.ok).toBe(true)
		expect(dry.dryRun).toBe(true)
		expect(readdirSync(root)).toEqual([])
		expect(dry.output).toEqual({
			a: { path: "pkg/package.json", op: "create", contentHash: sha('{"name":"pkg"}\n') },
			b: { path: "pkg/src/index.ts", op: "create", contentHash: sha("export {}\n") },
		})
		expect(dry.changeset.map((e) => [e.path, e.op, e.content])).toEqual([
			["README.md", "create", "# pkg\n"],
			["pkg/package.json", "create", '{"name":"pkg"}\n'],
			["pkg/src/index.ts", "create", "export {}\n"],
		])
		expect(dry.compensation).toEqual({ created: [], createdDirs: [], overwritten: [], recipeData: null })

		const real = await run(registry)
		expect(real.outputTreeHash).toBe(dry.outputTreeHash)
	})

	it("sees the files the templates plan, and its reads see its own writes", async () => {
		const { registry } = setup({
			supportsDryRun: true,
			templates: { "README.md.hbs": "templated\n" },
			recipeTs: `export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => {
				const seen = ctx.files.readText("README.md")
				ctx.files.write("copy.md", seen)
				return { success: true, output: { seen, copy: ctx.files.readText("copy.md") }, compensationData: null }
			}, compensate: async () => {} }`,
		})
		const dry = await run(registry, { dryRun: true })
		expect(dry.output).toEqual({ seen: "templated\n", copy: "templated\n" })
		expect(dry.changeset.map((e) => e.path)).toEqual(["README.md", "copy.md"])
		const real = await run(registry)
		expect(real.outputTreeHash).toBe(dry.outputTreeHash)
	})

	it("ctx.dryRun is true and a recipe can skip its non-file side effects", async () => {
		const { registry } = setup({
			supportsDryRun: true,
			recipeTs: `export const genRecipe = { name: "x", execute: async (_i, _s, ctx) => ({ success: true, output: { dryRun: ctx.dryRun }, compensationData: null }), compensate: async () => {} }`,
		})
		expect((await run(registry, { dryRun: true })).output).toEqual({ dryRun: true })
	})

	it("judges ctx.files.write against the disk: an existing identical file is unchanged, a differing one is skipped", async () => {
		const { root, registry } = setup({ recipeTs: WRITER, supportsDryRun: true })
		await run(registry)
		writeFileSync(join(root, "pkg", "package.json"), "mine\n")
		const dry = await run(registry, { dryRun: true })
		expect(ops(dry)).toEqual({ "pkg/package.json": "skip", "pkg/src/index.ts": "unchanged" })
		expect(readFileSync(join(root, "pkg", "package.json"), "utf-8")).toBe("mine\n")
	})

	it("fails with dry-run-violation, and removes what it created, when the recipe writes behind the API's back", async () => {
		const { root, registry } = setup({
			supportsDryRun: true,
			recipeTs: `
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
export const genRecipe = { name: "x", execute: async (_i, state) => {
	mkdirSync(join(state.targetDirectory, "sneaky"))
	writeFileSync(join(state.targetDirectory, "sneaky", "f.txt"), "f")
	return { success: true, output: null, compensationData: null }
}, compensate: async () => {} }`,
		})
		const result = await run(registry, { dryRun: true })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["dry-run-violation"])
		expect(result.diagnostics[0]?.message).toContain("sneaky/f.txt")
		expect(readdirSync(root)).toEqual([])
	})
})

describe("misc", () => {
	it("the files API works from compensate too", async () => {
		const { root, registry } = setup({
			recipeTs: `export const genRecipe = {
				name: "x",
				execute: async () => ({ success: true, output: null, compensationData: { go: true } }),
				compensate: async (_data, _state, ctx) => { ctx.files.write("compensated.txt", "yes") },
			}`,
		})
		const result = await run(registry)
		await compensateRecipe({ registry, pack: "fx", recipe: "gen", compensation: result.compensation })
		expect(readFileSync(join(root, "compensated.txt"), "utf-8")).toBe("yes")
	})
})
