import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRegistry, describeModules, runAction, TREE_HASH_DOMAIN } from "../src/index.js"
import { cleanupTempDirs, tempDir, writeModule } from "./helpers.js"

afterEach(cleanupTempDirs)

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

/** A "formatter": uppercases every file it is given and records its argv in `argv.log` next to the script (not in the project). */
const FORMATTER = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
const files = process.argv.slice(2)
appendFileSync(new URL("./argv.log", import.meta.url), JSON.stringify(process.argv.slice(2)) + "\\n")
if (files.includes("--fail")) { console.error("syntax error in x"); process.exit(3) }
for (const f of files.filter((a) => !a.startsWith("--"))) writeFileSync(f, readFileSync(f, "utf-8").toUpperCase())
`

function setup(
	format: { args?: string[]; command?: string } | null,
	templates: Record<string, string> = { "a.txt.hbs": "alpha\n", "b/c.txt.hbs": "beta\n" },
) {
	const root = tempDir()
	const modules = tempDir()
	const script = join(modules, "fmt.mjs")
	writeFileSync(script, FORMATTER)
	writeModule(modules, {
		name: "f",
		actions: [
			{
				id: "gen",
				templates,
				format: format
					? { command: format.command ?? process.execPath, args: format.args ?? [script, "{files}"] }
					: undefined,
			},
		],
	})
	return { root, modules, script, registry: createRegistry({ root, moduleDirs: [modules] }) }
}

const run = (registry: ReturnType<typeof setup>["registry"], extra: Record<string, unknown> = {}) =>
	runAction({ registry, module: "f", action: "gen", params: {}, ...extra })

describe("post-generate formatting hook", () => {
	it("never runs a module's command unless asked", async () => {
		const { root, modules, registry } = setup({})
		const result = await run(registry)
		expect(result.ok).toBe(true)
		expect(existsSync(join(modules, "argv.log"))).toBe(false)
		expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("alpha\n")
	})

	it("with format: true runs it over the created files and the receipt holds the formatted hashes", async () => {
		const { root, modules, registry } = setup({})
		const result = await run(registry, { format: true })
		expect(result.ok).toBe(true)
		expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("ALPHA\n")
		expect(readFileSync(join(root, "b", "c.txt"), "utf-8")).toBe("BETA\n")
		expect(JSON.parse(readFileSync(join(modules, "argv.log"), "utf-8"))).toEqual(["a.txt", "b/c.txt"])
		expect(result.changeset).toEqual([
			{ path: "a.txt", op: "create", contentHash: sha("ALPHA\n") },
			{ path: "b/c.txt", op: "create", contentHash: sha("BETA\n") },
		])
		expect(result.outputTreeHash).toBe(
			sha(`${TREE_HASH_DOMAIN}\na.txt\0${sha("ALPHA\n")}\nb/c.txt\0${sha("BETA\n")}\n`),
		)
	})

	it("passes only files the run created or updated, and appends them when the args have no {files}", async () => {
		const { root, modules, registry, script } = setup({})
		writeFileSync(join(root, "a.txt"), "alpha\n") // identical to its template: `unchanged`, not formatted
		const first = await run(registry, { format: true })
		expect(first.changeset.map((e) => e.op)).toEqual(["unchanged", "create"])
		expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("alpha\n")
		expect(readFileSync(join(root, "b", "c.txt"), "utf-8")).toBe("BETA\n")
		const appended = setup({ args: [script, "--flag"] })
		await run(appended.registry, { format: true })
		const calls = readFileSync(join(modules, "argv.log"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
		expect(calls).toEqual([["b/c.txt"], ["--flag", "a.txt", "b/c.txt"]])
	})

	it("a rerun finds the formatted files and reports them skipped with the same hash", async () => {
		const { registry } = setup({})
		const first = await run(registry, { format: true })
		const second = await run(registry, { format: true })
		// the templates are not formatter-stable, so the rerun sees differing bytes; the hash covers what is on disk
		expect(second.changeset.map((e) => e.op)).toEqual(["skip", "skip"])
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
	})

	it("templates that are already formatter-stable rerun as unchanged", async () => {
		const { registry } = setup({}, { "a.txt.hbs": "ALREADY STABLE\n" })
		const first = await run(registry, { format: true })
		const second = await run(registry, { format: true })
		expect(second.changeset.map((e) => e.op)).toEqual(["unchanged"])
		expect(second.outputTreeHash).toBe(first.outputTreeHash)
	})

	it("a formatter that fails rolls the whole run back with format-failed and shows its output", async () => {
		const { root, registry, script } = setup({})
		const failing = setup({ args: [script, "--fail", "{files}"] })
		const ok = await run(registry, { format: true })
		expect(ok.ok).toBe(true)
		const result = await run(failing.registry, { format: true })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["format-failed"])
		expect(result.diagnostics[0]?.message).toContain("exited 3")
		expect(result.diagnostics[0]?.message).toContain("syntax error in x")
		expect(result.changeset).toEqual([])
		expect(readdirSync(failing.root)).toEqual([])
		expect(readdirSync(root).sort()).toEqual(["a.txt", "b"])
	})

	it("an action that declares no formatter is untouched by format: true", async () => {
		const { root, registry } = setup(null)
		const result = await run(registry, { format: true })
		expect(result.ok).toBe(true)
		expect(readdirSync(root).sort()).toEqual(["a.txt", "b"])
	})

	it("a command that cannot start fails the run and leaves nothing behind", async () => {
		const { root, registry } = setup({ command: "baka-no-such-formatter", args: ["{files}"] })
		const result = await run(registry, { format: true })
		expect(result.ok).toBe(false)
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["format-failed"])
		expect(readdirSync(root)).toEqual([])
	})

	it("is refused in a dry run, which cannot format files that are not written", async () => {
		const { root, registry } = setup({})
		const result = await run(registry, { format: true, dryRun: true })
		expect(result.diagnostics.map((d) => d.rule)).toEqual(["dry-run-unsupported"])
		expect(readdirSync(root)).toEqual([])
	})

	it("is declared in the catalog, so a caller can run it itself", () => {
		const { script, registry } = setup({})
		const action = describeModules(registry).modules[0]?.actions[0]
		expect(action?.format).toEqual({ command: process.execPath, args: [script, "{files}"] })
	})
})
