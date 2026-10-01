import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	parseModuleAction,
	parseParamFlags,
	runFillCommand,
	runInspectCommand,
	runListModulesCommand,
	runLockCommand,
	runRunCommand,
	runSlotsCommand,
} from "./run.js"

describe("parseModuleAction", () => {
	it("splits module/action", () => {
		expect(parseModuleAction("hello/greet")).toEqual({
			module: "hello",
			action: "greet",
		})
	})
})

describe("parseParamFlags", () => {
	it("reads --productName without treating --cwd or --json as params", () => {
		const argv = [
			"node",
			"baka",
			"--cwd",
			"/tmp/probe",
			"run",
			"hello/greet",
			"--name",
			"Foo",
			"--json",
			"--params",
			'{"tone":"serious"}',
		]
		expect(parseParamFlags(argv)).toEqual({ name: "Foo" })
	})

	it("does not take --no-validate or --include-content as params", () => {
		expect(parseParamFlags(["--name", "x", "--no-validate", "--include-content", "--on-existing", "fail"])).toEqual({
			name: "x",
		})
	})

	it("merges --params JSON with extra flags", () => {
		expect(parseParamFlags(["--name", "probe"], '{"description":"hi"}')).toEqual({
			description: "hi",
			name: "probe",
		})
	})
})

const cleanup: string[] = []
afterEach(() => {
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function fixtureProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-cli-run-"))
	cleanup.push(dir)
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", private: true }))
	const templates = join(dir, "modules", "hello", "greet", "templates")
	mkdirSync(templates, { recursive: true })
	writeFileSync(
		join(dir, "modules", "hello", "manifest.ts"),
		`export const Manifest = {
  name: "hello",
  version: "0.0.0",
  description: "fixture",
  dependencies: [],
  conflictsWith: [],
  actions: [{
    id: "greet",
    description: "write a greeting",
    params: [{ name: "name", type: "string", required: true, description: "who" }],
    requiresReasoning: false,
    filePatterns: ["hello.md"],
    validators: [],
  }],
  moduleValidators: [],
}
`,
	)
	writeFileSync(
		join(templates, "hello.md.hbs"),
		`# {{name}}\n{{#slot "blurb" kind="prose" max=80}}one sentence{{/slot}}\n`,
	)
	return dir
}

describe("run / slots / fill / list-modules via engineRequest", () => {
	it("lists modules, lists slots, pins a fill, and materializes a byte-identical tree", async () => {
		const cwd = fixtureProject()
		const logs: string[] = []
		const orig = console.log
		console.log = (msg?: unknown) => {
			logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
		}
		try {
			await runListModulesCommand({ cwd, json: true })
			expect(logs.at(-1)).toContain('"name": "hello"')

			await runInspectCommand("hello/greet", { cwd, json: true })
			expect(logs.at(-1)).toContain("hello.md.hbs")
			expect(logs.at(-1)).toContain("{{#slot")

			await runSlotsCommand("hello/greet", { cwd, json: true })
			expect(logs.at(-1)).toContain('"id": "blurb"')

			await runFillCommand("hello/greet", {
				cwd,
				json: true,
				slot: "blurb",
				value: "A greeting.",
				extra: ["--name", "Ada"],
			})
			expect(logs.at(-1)).toContain('"ok": true')

			await runRunCommand("hello/greet", { cwd, json: true, extra: ["--name", "Ada"] })
			expect(logs.at(-1)).toContain('"ok": true')
			expect(readFileSync(join(cwd, "hello.md"), "utf-8")).toBe("# Ada\nA greeting.\n")
		} finally {
			console.log = orig
		}
	})

	it("replays a recorded receipt with --slot-records and reproduces its tree hash", async () => {
		const recorded = fixtureProject()
		const logs: string[] = []
		const orig = console.log
		console.log = (msg?: unknown) => {
			logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
		}
		try {
			await runFillCommand("hello/greet", {
				cwd: recorded,
				json: true,
				slot: "blurb",
				value: "A greeting.",
				extra: ["--name", "Ada"],
			})
			await runRunCommand("hello/greet", { cwd: recorded, json: true, extra: ["--name", "Ada"] })
			const receipt = JSON.parse(logs.at(-1) ?? "{}") as { outputTreeHash: string }
			const receiptFile = join(recorded, "receipt.json")
			writeFileSync(receiptFile, logs.at(-1) ?? "{}")

			const replayCwd = fixtureProject()
			await runRunCommand("hello/greet", {
				cwd: replayCwd,
				json: true,
				slotRecords: receiptFile,
				extra: ["--name", "Ada"],
			})
			const replayed = JSON.parse(logs.at(-1) ?? "{}") as { ok: boolean; outputTreeHash: string }
			expect(replayed.ok).toBe(true)
			expect(replayed.outputTreeHash).toBe(receipt.outputTreeHash)
			expect(readFileSync(join(replayCwd, "hello.md"), "utf-8")).toBe("# Ada\nA greeting.\n")
		} finally {
			console.log = orig
		}
	})

	it("`baka lock` pins the discovered modules in baka.lock.json", () => {
		const cwd = fixtureProject()
		const logs: string[] = []
		const orig = console.log
		console.log = (msg?: unknown) => {
			logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
		}
		try {
			runLockCommand({ cwd, json: true })
			const printed = JSON.parse(logs.at(-1) ?? "{}") as { path: string }
			expect(printed.path).toBe(join(cwd, "baka.lock.json"))
			const lock = JSON.parse(readFileSync(printed.path, "utf-8")) as {
				lockfileVersion: number
				modules: Record<string, { version: string; contentHash: string }>
			}
			expect(lock.lockfileVersion).toBe(1)
			expect(Object.keys(lock.modules)).toEqual(["hello"])
			expect(lock.modules.hello?.version).toBe("0.0.0")
			expect(lock.modules.hello?.contentHash).toMatch(/^[0-9a-f]{64}$/)
		} finally {
			console.log = orig
		}
	})
})
