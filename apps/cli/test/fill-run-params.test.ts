// `baka fill` keys the slot cache by the params a `baka run` will see (defaults applied, flags coerced),
// so a manual fill made with only the params typed is replayed by a run with the same typed params.
// A slot record that declares `match: "template"` (what a catalog ships as a default) fills the slot for any params.

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"

const DIST_INDEX = join(__dirname, "..", "..", "..", "apps", "cli", "dist", "index.js")

const created: string[] = []
afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	created.push(dir)
	return dir
}

function cli(
	argv: string[],
	cwd: string,
	home: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("node", [DIST_INDEX, ...argv], {
			cwd,
			env: { ...process.env, HOME: home, BAKA_HOME: home, XDG_CONFIG_HOME: home, BAKA_MODULE_DIRS: "" },
		})
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (b: Buffer) => {
			stdout += b.toString()
		})
		child.stderr.on("data", (b: Buffer) => {
			stderr += b.toString()
		})
		child.on("close", (code) => resolve({ code, stdout, stderr }))
	})
}

it("replays a manual fill in a run with the same typed params when the action has defaults", async () => {
	const project = tmp("baka-fillrun-")
	const home = tmp("baka-fillrun-home-")
	const root = join(project, "modules", "note")
	mkdirSync(join(root, "write", "templates"), { recursive: true })
	writeFileSync(
		join(root, "manifest.ts"),
		`export const Manifest = { name: "note", version: "0.0.0", description: "x", dependencies: [], conflictsWith: [],
  actions: [{ id: "write", description: "x", requiresReasoning: true, filePatterns: [], validators: [], params: [
    { name: "title", type: "string", required: true, description: "t" },
    { name: "infrastructure", type: "array", required: false, description: "t", items: { type: "string" }, default: [] },
    { name: "level", type: "number", required: false, description: "t", default: 1 },
  ] }], moduleValidators: [] }
`,
	)
	writeFileSync(
		join(root, "write", "templates", "note.md.hbs"),
		`# {{title}} {{level}}\n{{#slot "line" kind="prose" max=40}}one{{/slot}}\n`,
	)

	const filled = await cli(
		["fill", "note/write", "--slot", "line", "--value", "Pinned.", "--title", "Probe", "--level", "2"],
		project,
		home,
	)
	expect(filled.code, filled.stderr).toBe(0)
	const run = await cli(["run", "note/write", "--title", "Probe", "--level", "2", "--json"], project, home)
	expect(run.code, run.stderr).toBe(0)
	expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, slots: [{ id: "line", source: "cache", model: "manual" }] })
	expect(readFileSync(join(project, "note.md"), "utf-8")).toBe("# Probe 2\nPinned.\n")
})

it("replays a template-matched slot fixture for any params, keyed by the templateKey `baka slots` reports", async () => {
	const project = tmp("baka-fixture-")
	const home = tmp("baka-fixture-home-")
	const root = join(project, "modules", "note")
	mkdirSync(join(root, "write", "templates"), { recursive: true })
	mkdirSync(join(root, "fixtures"), { recursive: true })
	writeFileSync(
		join(root, "manifest.ts"),
		`export const Manifest = { name: "note", version: "0.0.0", description: "x", dependencies: [], conflictsWith: [],
  actions: [{ id: "write", description: "x", requiresReasoning: true, filePatterns: [], validators: [], params: [
    { name: "title", type: "string", required: true, description: "t" },
  ] }], moduleValidators: [] }
`,
	)
	writeFileSync(
		join(root, "write", "templates", "{{title}}.md.hbs"),
		`# {{title}}\n{{#slot "line" kind="prose" max=40}}one{{/slot}}\n`,
	)

	const slots = await cli(["slots", "note/write", "--json"], project, home)
	expect(slots.code, slots.stderr).toBe(0)
	const [slot] = JSON.parse(slots.stdout).slots as Array<{ id: string; templateKey: string }>
	expect(slot?.templateKey).toMatch(/^[0-9a-f]{64}$/)
	const fixture = join(root, "fixtures", "write.slots.json")
	writeFileSync(
		fixture,
		JSON.stringify([
			{ id: "line", key: slot?.templateKey, match: "template", model: "manual", value: "A default.", source: "replay" },
		]),
	)

	for (const title of ["alpha", "beta"]) {
		const run = await cli(["run", "note/write", "--title", title, "--slot-records", fixture, "--json"], project, home)
		expect(run.code, run.stderr).toBe(0)
		expect(readFileSync(join(project, `${title}.md`), "utf-8")).toBe(`# ${title}\nA default.\n`)
	}
})
