// The first run: a fresh install, an empty home, no model configured, and a recipe that works.
// Also the per-call surface a host relies on: bare recipe names, supplied slot values, --isolated,
// --llm-* flags, JSON errors and the four exit codes.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { copyPlatformFixtures } from "./helpers/copy-fixtures"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")

const createdDirs: string[] = []
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	createdDirs.push(dir)
	return dir
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\``)
})

interface Result {
	code: number | null
	stdout: string
	stderr: string
}

function baka(argv: string[], cwd: string, home: string, env: Record<string, string> = {}): Promise<Result> {
	return new Promise((resolve) => {
		// Nothing of the machine's own configuration may leak in: HOME and BAKA_HOME are fresh, BAKA_LLM_* is unset.
		const clean = { ...process.env }
		for (const key of Object.keys(clean)) if (key.startsWith("BAKA_")) delete clean[key]
		const child = spawn("node", [DIST_INDEX, ...argv], {
			cwd,
			env: { ...clean, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, ...env },
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

/** A pack with one recipe that writes `out.txt`: the smallest manifest discovery accepts. */
function writeSmallPack(packsDir: string, name: string, version: string): void {
	const root = join(packsDir, name)
	mkdirSync(join(root, "r", "templates"), { recursive: true })
	writeFileSync(
		join(root, "manifest.ts"),
		`export const Manifest = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, description: "small", dependencies: [], conflictsWith: [], recipes: [{ id: "r", description: "writes out.txt", requiresReasoning: false, filePatterns: ["out.txt"], validators: [], params: [] }], packValidators: [] }\n`,
	)
	writeFileSync(join(root, "r", "templates", "out.txt.hbs"), "out\n")
}

function freshProject(): { project: string; home: string } {
	const project = tempDir("baka-first-proj-")
	writeFileSync(join(project, "package.json"), JSON.stringify({ name: "first", private: true }))
	return { project, home: tempDir("baka-first-home-") }
}

describe("the first run needs no model and no setup", () => {
	it("runs a bundled recipe by its bare name", async () => {
		const { project, home } = freshProject()
		const run = await baka(["run", "add-readme", "--name", "my-app", "--json"], project, home)
		expect(run.code, run.stderr).toBe(0)
		expect((JSON.parse(run.stdout) as { ok: boolean }).ok).toBe(true)
		expect(readFileSync(join(project, "README.md"), "utf-8")).toContain("# my-app")
	})

	it("still accepts pack/recipe", async () => {
		const { project, home } = freshProject()
		const run = await baka(["run", "starter/add-readme", "--name", "again"], project, home)
		expect(run.code, run.stderr).toBe(0)
		expect(readFileSync(join(project, "README.md"), "utf-8")).toContain("# again")
	})

	it("lists the starter pack in an empty directory", async () => {
		const { project, home } = freshProject()
		const listed = await baka(["list-packs", "--json"], project, home)
		expect(listed.code, listed.stderr).toBe(0)
		const names = (JSON.parse(listed.stdout) as { packs: Array<{ name: string }> }).packs.map((p) => p.name)
		expect(names).toContain("starter")
	})

	it("lets a pack in the project replace the bundled one of the same name", async () => {
		const { project, home } = freshProject()
		copyPlatformFixtures(project, ["slot-mod"])
		writeSmallPack(join(project, "packs"), "starter", "9.9.9")
		const listed = await baka(["list-packs", "--json"], project, home)
		const packs = (JSON.parse(listed.stdout) as { packs: Array<{ name: string; version: string }> }).packs
		expect(packs.find((p) => p.name === "starter")?.version).toBe("9.9.9")
	})
})

describe("slots without a model", () => {
	function slotProject(): { project: string; home: string } {
		const fresh = freshProject()
		copyPlatformFixtures(fresh.project, ["slot-mod"])
		return fresh
	}

	it("reports the open slots and what to pass, exit 1", async () => {
		const { project, home } = slotProject()
		const run = await baka(["run", "write", "--title", "Probe", "--json"], project, home)
		expect(run.code).toBe(1)
		const receipt = JSON.parse(run.stdout) as { ok: boolean; openSlots: Array<{ id: string }> }
		expect(receipt.ok).toBe(false)
		expect(receipt.openSlots.map((s) => s.id)).toEqual(["line"])
		expect(run.stderr).toContain("--slot line=")
		expect(existsSync(join(project, "note.md"))).toBe(false)
	})

	it("fills a slot from --slot id=value", async () => {
		const { project, home } = slotProject()
		const run = await baka(["run", "write", "--title", "Probe", "--slot", "line=A short note."], project, home)
		expect(run.code, run.stderr).toBe(0)
		expect(readFileSync(join(project, "note.md"), "utf-8")).toContain("A short note.")
	})

	it("fills slots from --slots-file, a JSON object of id to value", async () => {
		const { project, home } = slotProject()
		const file = join(tempDir("baka-slots-"), "slots.json")
		writeFileSync(file, JSON.stringify({ line: "From a file." }))
		const run = await baka(["run", "write", "--title", "Probe", "--slots-file", file], project, home)
		expect(run.code, run.stderr).toBe(0)
		expect(readFileSync(join(project, "note.md"), "utf-8")).toContain("From a file.")
	})

	it("refuses a slot the recipe does not declare as bad input, exit 2", async () => {
		const { project, home } = slotProject()
		const run = await baka(["run", "write", "--title", "Probe", "--slot", "nope=x", "--json"], project, home)
		expect(run.code).toBe(2)
	})
})

describe("per-call configuration", () => {
	it("--isolated ignores the user's packs", async () => {
		const { project, home } = freshProject()
		writeSmallPack(join(home, ".baka", "packs"), "mine", "1.0.0")
		const names = async (extra: string[]) => {
			const out = await baka(["list-packs", "--json", ...extra], project, home, { BAKA_HOME: join(home, ".baka") })
			return (JSON.parse(out.stdout) as { packs: Array<{ name: string }> }).packs.map((p) => p.name)
		}
		expect(await names([])).toContain("mine")
		expect(await names(["--isolated"])).not.toContain("mine")
		expect(await names(["--isolated"])).toContain("starter")
	})

	it("names a missing api-key variable on stderr, exit 2", async () => {
		const { project, home } = freshProject()
		const run = await baka(
			[
				"run",
				"add-readme",
				"--name",
				"x",
				"--llm-base-url",
				"http://127.0.0.1:1/v1",
				"--llm-model",
				"m",
				"--llm-api-key-env",
				"NOPE_KEY",
			],
			project,
			home,
		)
		expect(run.code).toBe(2)
		expect(run.stderr).toContain("NOPE_KEY")
	})

	it("the same call through BAKA_LLM_* is understood too", async () => {
		const { project, home } = freshProject()
		const run = await baka(["run", "add-readme", "--name", "x"], project, home, {
			BAKA_LLM_BASE_URL: "http://127.0.0.1:1/v1",
			BAKA_LLM_MODEL: "m",
		})
		expect(run.code, run.stderr).toBe(0)
	})
})

describe("errors a machine can read", () => {
	it("an unknown recipe with --json is { error: { code, message } } on stdout, exit 2", async () => {
		const { project, home } = freshProject()
		const run = await baka(["run", "no-such-recipe", "--json"], project, home)
		expect(run.code).toBe(2)
		const body = JSON.parse(run.stdout) as { error: { code: string; message: string } }
		expect(body.error.code).toBe("recipe-not-found")
		expect(body.error.message).toContain("no-such-recipe")
	})

	it("a bad flag with --json is the same shape, exit 2", async () => {
		const { project, home } = freshProject()
		const run = await baka(["run", "add-readme", "--on-existing", "sometimes", "--json"], project, home)
		expect(run.code).toBe(2)
		expect((JSON.parse(run.stdout) as { error: { code: string } }).error.code).toBe("bad-request")
	})

	it("a missing --cwd with --json is the same shape, exit 2", async () => {
		const { project, home } = freshProject()
		const run = await baka(["--cwd", join(project, "nowhere"), "list-packs", "--json"], project, home)
		expect(run.code).toBe(2)
		expect((JSON.parse(run.stdout) as { error: { code: string } }).error.code).toBe("bad-request")
	})
})

describe("add-ons", () => {
	function writeAddon(dir: string, name: string, source: string): string {
		const file = join(dir, name)
		writeFileSync(file, source)
		return file
	}

	it("--addon attaches a module that can refuse a run before anything is written", async () => {
		const { project, home } = freshProject()
		writeAddon(
			project,
			"gate.mjs",
			'export default { name: "gate", beforeRun() { throw new Error("not on this plan") } }\n',
		)
		const run = await baka(["run", "add-readme", "--name", "x", "--addon", "./gate.mjs", "--json"], project, home)
		expect(run.code).toBe(1)
		const receipt = JSON.parse(run.stdout) as { ok: boolean; diagnostics: Array<{ rule: string; message: string }> }
		expect(receipt.diagnostics[0]).toMatchObject({ rule: "addon-refused", message: "gate: not on this plan" })
		expect(existsSync(join(project, "README.md"))).toBe(false)
	})

	it("BAKA_ADDONS attaches one too, and afterRun sees the receipt", async () => {
		const { project, home } = freshProject()
		const log = join(project, "seen.txt")
		writeAddon(
			project,
			"history.mjs",
			`import { appendFileSync } from "node:fs"\nexport default { name: "history", afterRun(r) { appendFileSync(${JSON.stringify(log)}, r.recipe + " " + r.ok + "\\n") } }\n`,
		)
		const run = await baka(["run", "add-readme", "--name", "x"], project, home, {
			BAKA_ADDONS: join(project, "history.mjs"),
		})
		expect(run.code, run.stderr).toBe(0)
		expect(readFileSync(log, "utf-8")).toBe("add-readme true\n")
	})

	it("an add-on that cannot be loaded is bad input, exit 2, naming it", async () => {
		const { project, home } = freshProject()
		const run = await baka(["run", "add-readme", "--name", "x", "--addon", "./nowhere.mjs", "--json"], project, home)
		expect(run.code).toBe(2)
		const body = JSON.parse(run.stdout) as { error: { code: string; message: string } }
		expect(body.error.code).toBe("addon-invalid")
		expect(body.error.message).toContain("nowhere.mjs")
	})
})

describe("the open core makes no network connection of its own", () => {
	it("lists, inspects and runs a recipe without opening a socket, resolving a name or calling fetch", async () => {
		const { project, home } = freshProject()
		const trace = join(tempDir("baka-net-"), "trace.txt")
		const preload = join(tempDir("baka-net-"), "trace.cjs")
		writeFileSync(
			preload,
			`const fs = require("node:fs")
const net = require("node:net")
const dns = require("node:dns")
const note = (what) => fs.appendFileSync(${JSON.stringify(trace)}, what + "\\n")
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) { note("connect " + JSON.stringify(args[0])); return connect.apply(this, args) }
const lookup = dns.lookup
dns.lookup = function (...args) { note("lookup " + args[0]); return lookup.apply(this, args) }
const realFetch = globalThis.fetch
globalThis.fetch = function (...args) { note("fetch " + String(args[0])); return realFetch.apply(this, args) }
`,
		)
		const env = { NODE_OPTIONS: `--require ${preload}` }
		for (const argv of [
			["version", "--json"],
			["health"],
			["list-packs", "--json"],
			["inspect", "add-readme"],
			["run", "add-readme", "--name", "x"],
		]) {
			const out = await baka(argv, project, home, env)
			expect(out.code, `${argv.join(" ")}: ${out.stderr}`).toBe(0)
		}
		expect(existsSync(trace) ? readFileSync(trace, "utf-8") : "").toBe("")
	})
})
