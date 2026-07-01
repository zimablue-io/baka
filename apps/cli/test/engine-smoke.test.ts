// ---------------------------------------------------------------------------
// Black-box smoke tests for the engine surface of the `baka` binary
// after the role-keyed config refactor.
//
// Every probe in this file spawns the BUILT artifact
// (`apps/cli/dist/index.js`) as a subprocess, never `tsx` against source,
// never in-process. The binary must behave as documented end-to-end.
//
// Coverage map (per `validation-contract.md`):
//
//   VAL-CLI-010  module create <badname> exits 1 without LLM call
//   VAL-CLI-011  module validate <good-name> --json
//   VAL-CLI-012  module list-actions <name>
//   VAL-CLI-013  module test <name> --action <id>
//   VAL-CLI-014  module test missing/unknown --action exits 1
//   VAL-CLI-020  plan --help lists all documented options
//   VAL-CLI-021  plan --dry-run runs against the fake-LLM harness
//   VAL-CLI-022  plan --json emits the documented shape
//   VAL-CLI-023  plan --save writes a valid .plan.json
//   VAL-CLI-024  plan without a worker role configured exits 1 cleanly
//   VAL-CLI-025  list-plans enumerates .baka/plans/*.plan.json
//   VAL-CLI-026  apply <missing-plan> exits 2
//   VAL-CLI-027  apply <valid-plan> --json emits the documented contract
//   VAL-CLI-028  validate prints the per-module summary
//   VAL-CLI-029  validate --json emits the documented contract
//   VAL-CLI-030  validate from an empty cwd reports 0 modules
//   VAL-ROLE-010 baka plan with worker configured but validator missing still succeeds
//   VAL-ROLE-011 baka validate -m sdd with validator missing fails cleanly
//   VAL-ROLE-012 baka plan with no role configured fails with worker error
//
// LLM-bound probes (plan / apply) route through a fake LLM harness bound
// to 127.0.0.1:0. The harness is hermetic: no real network, no API keys,
// no flake. We seed a baka config in a fake HOME so the CLI reads the
// fake LLM endpoint without touching the user real config.
//
// Conventions:
//   - spawn `node` against the built `apps/cli/dist/index.js` (no tsx)
//   - always use a fresh temp dir under $TMPDIR per test; clean up
//   - always use a fresh fake $HOME for any probe that touches the
//     user config; never pollute the user's real config
//   - capture stdout and stderr separately; assert on each
//   - 30-second timeouts per test (the suite is hermetic; failures
//     should be fast)
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const EMPTY_CWD = join(tmpdir(), "baka-engine-smoke-empty")

/** Spawn the built CLI and resolve with the captured stdout, stderr, and exit code. */
function spawnCli(args: {
	argv: string[]
	cwd?: string
	env?: Record<string, string>
	bakaConfig?: {
		worker?: { baseUrl: string; model: string; apiKey?: string }
		validator?: { baseUrl: string; model: string; apiKey?: string }
	}
	timeoutMs?: number
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	let env: NodeJS.ProcessEnv = { ...process.env, ...args.env }
	if (args.bakaConfig) {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-cli-cfg-"))
		createdDirs.push(fakeHome)
		seedRoleConfig(fakeHome, args.bakaConfig)
		env = { ...env, HOME: fakeHome, XDG_CONFIG_HOME: fakeHome, XDG_DATA_HOME: fakeHome }
	}
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...args.argv], {
			cwd: args.cwd ?? BAKA_REPO,
			env,
		})
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))

		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve({ code: null, stdout, stderr: `${stderr}\n[test: killed after ${args.timeoutMs ?? 30_000}ms timeout]` })
		}, args.timeoutMs ?? 30_000)

		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

/** Write a baka config to <home>/.baka/config.json with the role-keyed shape. */
function seedRoleConfig(
	home: string,
	cfg: {
		worker?: { baseUrl: string; model: string; apiKey?: string }
		validator?: { baseUrl: string; model: string; apiKey?: string }
	},
) {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	const out: Record<string, unknown> = {}
	if (cfg.worker) {
		out.worker = {
			baseUrl: cfg.worker.baseUrl,
			model: cfg.worker.model,
			apiKey: cfg.worker.apiKey ?? "test-worker-key",
			temperature: 0,
			maxTokens: 8192,
			timeoutMs: 120000,
		}
	}
	if (cfg.validator) {
		out.validator = {
			baseUrl: cfg.validator.baseUrl,
			model: cfg.validator.model,
			apiKey: cfg.validator.apiKey ?? "test-validator-key",
			temperature: 0,
			maxTokens: 8192,
			timeoutMs: 120000,
		}
	}
	writeFileSync(join(dir, "config.json"), JSON.stringify(out, null, 2))
}

/** Spawn the CLI with a fresh fake HOME so the user config is isolated. */
function spawnCliWithFakeHome(args: {
	argv: string[]
	cwd?: string
	fakeHome: string
	bakaConfig?: {
		worker?: { baseUrl: string; model: string; apiKey?: string }
		validator?: { baseUrl: string; model: string; apiKey?: string }
	}
	timeoutMs?: number
}) {
	if (args.bakaConfig) seedRoleConfig(args.fakeHome, args.bakaConfig)
	return spawnCli({
		argv: args.argv,
		cwd: args.cwd ?? BAKA_REPO,
		env: { HOME: args.fakeHome, XDG_CONFIG_HOME: args.fakeHome, XDG_DATA_HOME: args.fakeHome },
		timeoutMs: args.timeoutMs,
	})
}

/** Create a fresh empty temp dir; returns its path. Caller is responsible for cleanup. */
function makeEmptyDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

/** Track every temp dir we create so we can clean them all up in afterEach. */
const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

// ---------------------------------------------------------------------------
// Fake LLM harness (OpenAI-compatible, /chat/completions)
//
// Returns a scripted sequence of responses (OpenAI wire format with a JSON
// content string). `calls` increments on each request so tests can assert
// the LLM was (or was not) invoked. The harness binds to 127.0.0.1:0 to
// avoid port conflicts.
// ---------------------------------------------------------------------------

interface ScriptedResponse {
	content: string
}

interface FakeLLMHandle {
	url: string
	port: number
	calls: number
	close(): Promise<void>
}

function startFakeLLM(script: ScriptedResponse[]): Promise<FakeLLMHandle> {
	let calls = 0
	let scriptIdx = 0
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.url !== "/chat/completions" && req.url !== "/v1/chat/completions") {
			res.statusCode = 404
			res.end("not found")
			return
		}
		let body = ""
		req.on("data", (chunk: Buffer) => (body += chunk))
		req.on("end", () => {
			calls++
			const next = script[scriptIdx++] ?? script[script.length - 1]
			res.setHeader("Content-Type", "application/json")
			res.end(
				JSON.stringify({
					id: `fake-${calls}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: "fake-llm",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: next.content },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
				}),
			)
		})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || !addr) {
				throw new Error("fake LLM: failed to bind")
			}
			resolve({
				url: `http://127.0.0.1:${addr.port}/v1`,
				port: addr.port,
				get calls() {
					return calls
				},
				close: () =>
					new Promise<void>((res) => {
						server.close(() => res())
					}),
			})
		})
	})
}

/** Standard fake-LLM response: a single baka-base:scaffold step. */
function planResponse(name: string): ScriptedResponse {
	return {
		content: JSON.stringify({
			resolvedSteps: [
				{
					id: "step-1",
					module: "baka-base",
					action: "scaffold",
					params: { name, moduleType: "esm" },
				},
			],
		}),
	}
}

/** Prepare a temp scratch dir with the in-repo modules symlinked under modules/. */
function prepareScratchWithModules(prefix: string): string {
	const scratch = trackDir(makeEmptyDir(prefix))
	mkdirSync(join(scratch, "modules"), { recursive: true })
	for (const mod of ["baka-base", "sdd", "ts-style"]) {
		const target = join(BAKA_REPO, "modules", mod)
		const link = join(scratch, "modules", mod)
		// Use absolute symlinks so they resolve regardless of the cwd we pass.
		symlinkSync(target, link)
	}
	return scratch
}

// ---------------------------------------------------------------------------
// Test fixture prep
// ---------------------------------------------------------------------------

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	if (!existsSync(EMPTY_CWD)) {
		mkdirSync(EMPTY_CWD, { recursive: true })
	}
})

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// Fake-LLM handle for tests that share a harness across multiple probes.
// ---------------------------------------------------------------------------

let sharedFakeLLM: FakeLLMHandle | null = null

afterEach(async () => {
	if (sharedFakeLLM) {
		await sharedFakeLLM.close()
		sharedFakeLLM = null
	}
})

async function startSharedFakeLLM(script: ScriptedResponse[]): Promise<FakeLLMHandle> {
	sharedFakeLLM = await startFakeLLM(script)
	return sharedFakeLLM
}

// ===========================================================================
// VAL-CLI-010  module create <badname> exits 1 without LLM call
// ===========================================================================

describe("VAL-CLI-010 baka module create <badname>", () => {
	it("rejects a bad name (no LLM, no stack trace, USER_ERROR exit 1)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-module-create-bad-"))
		const llm = await startFakeLLM([]) // No scripted responses; an LLM hit would 500.

		try {
			const { code, stdout, stderr } = await spawnCliWithFakeHome({
				argv: ["module", "create", "../../../etc/passwd"],
				fakeHome,
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})

			expect(code, `unexpected exit; stdout=${stdout}; stderr=${stderr}`).toBe(1)
			expect(stderr).toContain("module name must be")
			// No LLM call was made.
			expect(llm.calls, `fake LLM was hit ${llm.calls} times; expected 0`).toBe(0)
			// No Node stack frames.
			expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		} finally {
			await llm.close()
		}
	}, 30_000)
})

// ===========================================================================
// VAL-CLI-011  module validate <good-name> --json
// ===========================================================================

describe("VAL-CLI-011 baka module validate baka-base --json", () => {
	it("emits {module, valid, errors, warnings}; exit 0 for a well-formed module", async () => {
		const { code, stdout, stderr } = await spawnCli({
			argv: ["module", "validate", "baka-base", "--json"],
		})

		expect(code, `unexpected exit ${code}; stderr=${stderr}`).toBe(0)

		const parsed = JSON.parse(stdout) as {
			module: string
			valid: boolean
			errors: string[]
			warnings: string[]
		}
		expect(parsed.module).toBe("baka-base")
		expect(parsed.valid).toBe(true)
		expect(parsed.errors).toEqual([])
		expect(Array.isArray(parsed.warnings)).toBe(true)
	})
})

// ===========================================================================
// VAL-CLI-012  module list-actions <name>
// ===========================================================================

describe("VAL-CLI-012 baka module list-actions baka-base", () => {
	it("prints scaffold, add-script, add-dependency with params", async () => {
		const { code, stdout, stderr } = await spawnCli({
			argv: ["module", "list-actions", "baka-base"],
		})

		expect(code, `unexpected exit ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("module: baka-base")
		expect(stdout).toContain("- scaffold:")
		expect(stdout).toContain("- add-script:")
		expect(stdout).toContain("- add-dependency:")
		expect(stdout).toMatch(/\bname\b/)
	})
})

// ===========================================================================
// VAL-CLI-013  module test <name> --action <id> runs in a temp dir, no leak
// ===========================================================================

describe("VAL-CLI-013 baka module test baka-base --action scaffold", () => {
	it("runs the action, prints RESULT, leaves no temp dir behind", async () => {
		const before = new Set(listBakaTestDirs())

		const { code, stdout, stderr } = await spawnCli({
			argv: [
				"module",
				"test",
				"baka-base",
				"--action",
				"scaffold",
				"--input",
				JSON.stringify({ name: "probe-ts", moduleType: "esm" }),
			],
		})

		expect(code, `unexpected exit ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("RESULT:")
		expect(stdout).toContain("probe-ts")

		const after = listBakaTestDirs()
		const leftovers = after.filter((d) => !before.has(d))
		expect(leftovers, `leaked temp dirs: ${leftovers.join(", ")}`).toEqual([])
	})

	/** Returns absolute paths of every /tmp/baka-test-* directory that exists right now. */
	function listBakaTestDirs(): string[] {
		const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs")
		const entries = readdirSync(tmpdir()).filter((e) => e.startsWith("baka-test-"))
		return entries
			.map((e) => join(tmpdir(), e))
			.filter((p) => {
				try {
					return statSync(p).isDirectory()
				} catch {
					return false
				}
			})
	}
})

// ===========================================================================
// VAL-CLI-014  module test missing/unknown --action exits 1
// ===========================================================================

describe("VAL-CLI-014 baka module test baka-base with bad --action", () => {
	it("missing --action exits 1 with the documented message (no temp dir created)", async () => {
		const before = countBakaTestDirs()

		const { code, stdout, stderr } = await spawnCli({
			argv: ["module", "test", "baka-base"],
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain("--action")
		expect(stderr).toMatch(/required/i)
		expect(countBakaTestDirs()).toBe(before)
	})

	it("unknown --action exits 1 with the documented message (no temp dir created)", async () => {
		const before = countBakaTestDirs()

		const { code, stdout, stderr } = await spawnCli({
			argv: ["module", "test", "baka-base", "--action", "no-such-action"],
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain("no-such-action")
		expect(stderr).toContain("not found")
		expect(countBakaTestDirs()).toBe(before)
	})

	function countBakaTestDirs(): number {
		const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs")
		return readdirSync(tmpdir()).filter((e) => {
			if (!e.startsWith("baka-test-")) return false
			try {
				return statSync(join(tmpdir(), e)).isDirectory()
			} catch {
				return false
			}
		}).length
	}
})

// ===========================================================================
// VAL-CLI-020  plan --help lists all documented options
// ===========================================================================

describe("VAL-CLI-020 baka plan --help", () => {
	it("exits 0 and lists --dry-run, --save, --execute, --json, and the default intent", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["plan", "--help"] })

		expect(code, `unexpected exit ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("--dry-run")
		expect(stdout).toContain("--save")
		expect(stdout).toContain("--execute")
		expect(stdout).toContain("--json")
		expect(stdout).toContain("Set up core typescript")
		expect(stdout).toContain("with default configurations")
		expect(stdout).toMatch(/default: "Set up core typescript/)
	})
})

// ===========================================================================
// VAL-CLI-021  plan --dry-run runs end-to-end against the fake LLM
// ===========================================================================

describe("VAL-CLI-021 baka plan --dry-run", () => {
	it("emits a plan summary referencing baka-base:scaffold against the fake LLM", async () => {
		const scratch = prepareScratchWithModules("baka-plan-dry-run-")
		const llm = await startSharedFakeLLM([planResponse("probe-dry-run")])

		try {
			const { code, stdout, stderr } = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project", "--dry-run"],
				cwd: scratch,
				env: {},
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})

			expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)
			expect(stdout).toContain("plan:")
			expect(stdout).toMatch(/baka-base:scaffold/)
			expect(llm.calls).toBeGreaterThanOrEqual(1)
		} finally {
			// close handled by afterEach
		}
	}, 30_000)
})

// ===========================================================================
// VAL-CLI-022  plan --json emits the documented contract
// ===========================================================================

describe("VAL-CLI-022 baka plan --json", () => {
	it("emits {status, steps, logs} against the fake LLM", async () => {
		const scratch = prepareScratchWithModules("baka-plan-json-")
		const llm = await startSharedFakeLLM([planResponse("probe-json")])

		try {
			const { code, stdout, stderr } = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project", "--json"],
				cwd: scratch,
				env: {},
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})

			expect(code, `unexpected exit ${code}; stderr=${stderr}`).toBe(0)
			const parsed = JSON.parse(stdout) as {
				status: string
				steps: Array<{ module: string; action: string; params: Record<string, unknown> }>
				logs: string[]
			}
			expect(["SUCCESS", "FAILED"]).toContain(parsed.status)
			expect(Array.isArray(parsed.steps)).toBe(true)
			expect(parsed.steps.length).toBeGreaterThan(0)
			for (const step of parsed.steps) {
				expect(typeof step.module).toBe("string")
				expect(typeof step.action).toBe("string")
				expect(typeof step.params).toBe("object")
			}
			expect(Array.isArray(parsed.logs)).toBe(true)
		} finally {
			// close handled by afterEach
		}
	}, 30_000)
})

// ===========================================================================
// VAL-CLI-023  plan --save writes a valid .plan.json to .baka/plans/
// ===========================================================================

describe("VAL-CLI-023 baka plan --save", () => {
	it("writes .baka/plans/*.plan.json AND emits documented JSON when --save --json are passed together", async () => {
		const scratch = prepareScratchWithModules("baka-plan-save-")
		const llm = await startSharedFakeLLM([planResponse("probe-save")])

		try {
			const { code, stdout, stderr } = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project", "--save", "--json"],
				cwd: scratch,
				env: {},
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})

			expect(code, `unexpected exit ${code}; stderr=${stderr}`).toBe(0)

			const parsed = JSON.parse(stdout) as {
				status: string
				steps: Array<{ module: string; action: string; params: Record<string, unknown> }>
				logs: string[]
				planFile?: string
				savedAt?: string
			}
			expect(parsed.status).toBe("SUCCESS")
			expect(Array.isArray(parsed.steps)).toBe(true)
			expect(parsed.steps.length).toBeGreaterThan(0)
			expect(Array.isArray(parsed.logs)).toBe(true)
			expect(typeof parsed.planFile).toBe("string")
			expect(typeof parsed.savedAt).toBe("string")
			expect((parsed.planFile as string).endsWith(".plan.json")).toBe(true)

			const planFile = parsed.planFile as string
			expect(existsSync(planFile), `plan file not written at ${planFile}`).toBe(true)
			const plan = JSON.parse(readFileSync(planFile, "utf-8")) as {
				resolvedSteps: unknown[]
				meta?: { intent?: string; savedAt?: string }
			}
			expect(Array.isArray(plan.resolvedSteps)).toBe(true)
			expect(plan.resolvedSteps.length).toBeGreaterThan(0)
			expect(plan.meta?.intent).toBe("scaffold a TS project")
			expect(typeof plan.meta?.savedAt).toBe("string")

			const plansDirPath = join(scratch, ".baka", "plans")
			expect(planFile.startsWith(plansDirPath), `planFile ${planFile} not under ${plansDirPath}`).toBe(true)
			const planFiles = readdirSyncSafe(plansDirPath).filter((f) => f.endsWith(".plan.json"))
			expect(planFiles.length, `expected one .plan.json file, got ${planFiles.length}`).toBe(1)
		} finally {
			// close handled by afterEach
		}
	}, 30_000)
})

function readdirSyncSafe(dir: string): string[] {
	const { readdirSync } = require("node:fs") as typeof import("node:fs")
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

// ===========================================================================
// VAL-CLI-024  plan without a worker role configured exits 1, no stack
// ===========================================================================

describe("VAL-CLI-024 baka plan without worker role", () => {
	it("exits 1 with a single user-facing line suggesting `baka init` (no stack frames)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-plan-no-creds-"))

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["plan", "scaffold a TS project"],
			fakeHome,
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toMatch(/^baka:/m)
		expect(stderr).toContain("baka init")
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ===========================================================================
// VAL-DOG-012  plan "" (empty intent) returns a structured error
// ===========================================================================

describe("VAL-DOG-012 baka plan empty intent", () => {
	it("exits 2 with a FAILED JSON envelope and a 'no module matched: empty intent' diagnostic (no stack frames)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-plan-empty-intent-"))
		const llm = await startFakeLLM([{ content: "{}" }])

		try {
			const { code, stdout, stderr } = await spawnCliWithFakeHome({
				argv: ["plan", "", "--json"],
				fakeHome,
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})

			expect([0, 2], `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toContain(code)
			expect(code).toBe(2)

			const parsed = JSON.parse(stdout) as {
				status: string
				steps: unknown[]
				logs: string[]
			}
			expect(parsed.status).toBe("FAILED")
			expect(parsed.steps).toEqual([])
			expect(Array.isArray(parsed.logs)).toBe(true)
			expect(parsed.logs.some((line) => line.includes("no module matched") && line.includes("empty intent"))).toBe(true)

			expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
			expect(
				llm.calls,
				`LLM was called ${llm.calls} times; expected 0 (empty-intent check must precede loadLLMConfig)`,
			).toBe(0)
		} finally {
			await llm.close()
		}
	}, 30_000)

	it("exits 2 with the human-formatted 'no module matched' line when --json is omitted", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-plan-empty-intent-human-"))
		const llm = await startFakeLLM([{ content: "{}" }])

		try {
			const { code, stderr, stdout } = await spawnCliWithFakeHome({
				argv: ["plan", ""],
				fakeHome,
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})

			expect([0, 2], `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toContain(code)
			const combined = `${stdout}\n${stderr}`
			expect(combined).toContain("no module matched")
			expect(combined).toContain("empty intent")
			expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
			expect(llm.calls).toBe(0)
		} finally {
			await llm.close()
		}
	}, 30_000)
})

// ===========================================================================
// VAL-CLI-025  list-plans enumerates .baka/plans/*.plan.json
// ===========================================================================

describe("VAL-CLI-025 baka list-plans", () => {
	it("reports the saved plan's intent and timestamp after plan --save", async () => {
		const scratch = prepareScratchWithModules("baka-list-plans-")
		const llm = await startSharedFakeLLM([planResponse("probe-list-plans")])

		try {
			const save = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project", "--save", "--json"],
				cwd: scratch,
				env: {},
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})
			expect(save.code, `save failed: ${save.stderr}`).toBe(0)
			const saved = JSON.parse(save.stdout) as { planFile?: string }
			expect(typeof saved.planFile).toBe("string")

			const list = await spawnCli({
				argv: ["--cwd", scratch, "list-plans"],
				cwd: scratch,
			})

			expect(list.code, `list failed: ${list.stderr}`).toBe(0)
			expect(list.stdout).toContain("scaffold a TS project")
			expect(list.stdout).toMatch(/\d+ plan\(s\):/)
		} finally {
			// close handled by afterEach
		}
	}, 30_000)
})

// ===========================================================================
// VAL-CLI-026  apply <missing-plan> exits 2 with a clear message
// ===========================================================================

describe("VAL-CLI-026 baka apply <missing-plan>", () => {
	it("exits 2 with a single stderr line naming the missing plan (no stack frames)", async () => {
		const { code, stdout, stderr } = await spawnCli({
			argv: ["apply", "/no/such/plan.plan.json"],
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(2)
		expect(stderr).toMatch(/plan file not found/)
		expect(stderr).toContain("/no/such/plan.plan.json")
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ===========================================================================
// VAL-CLI-027  apply <valid-plan> --json emits the documented contract
// ===========================================================================

describe("VAL-CLI-027 baka apply <valid-plan> --json", () => {
	it("emits the apply contract; status is SUCCESS or VALIDATION_FAILED on a clean scratch tree", async () => {
		const scratch = prepareScratchWithModules("baka-apply-")
		const llm = await startSharedFakeLLM([planResponse("probe-apply")])

		try {
			const save = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project", "--save", "--json"],
				cwd: scratch,
				env: {},
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})
			expect(save.code, `save failed: ${save.stderr}`).toBe(0)
			const saved = JSON.parse(save.stdout) as { planFile?: string }
			expect(typeof saved.planFile).toBe("string")
			const planFile = saved.planFile as string

			const planFiles = readdirSyncSafe(join(scratch, ".baka", "plans")).filter((f) => f.endsWith(".plan.json"))
			expect(planFiles.length).toBe(1)

			const apply = await spawnCli({
				argv: ["--cwd", scratch, "apply", planFile, "--json"],
				cwd: scratch,
				env: {},
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})

			expect([0, 4], `unexpected exit ${apply.code}; stdout=${apply.stdout}; stderr=${apply.stderr}`).toContain(
				apply.code,
			)

			const parsed = JSON.parse(apply.stdout) as {
				status: string
				completedSteps: Array<{ module: string; action: string }>
				failed: unknown
				validation: { kind: string; diagnostics?: unknown[] }
				logs: string[]
			}
			expect(["SUCCESS", "VALIDATION_FAILED", "FAILED"]).toContain(parsed.status)
			expect(Array.isArray(parsed.completedSteps)).toBe(true)
			expect(Array.isArray(parsed.logs)).toBe(true)

			if (parsed.status === "SUCCESS") {
				expect(parsed.failed).toBeFalsy()
				expect(parsed.validation.kind).toBe("pass")
				expect(apply.code).toBe(0)
				expect(existsSync(join(scratch, "src", "index.ts"))).toBe(true)
			} else if (parsed.status === "VALIDATION_FAILED") {
				expect(apply.code).toBe(4)
				expect(parsed.validation.kind).toBe("fail")
				expect(parsed.validation.diagnostics?.length).toBeGreaterThan(0)
			}
		} finally {
			// close handled by afterEach
		}
	}, 60_000)
})

// ===========================================================================
// VAL-CLI-028  validate prints the per-module summary
// ===========================================================================

describe("VAL-CLI-028 baka validate", () => {
	it("prints a summary line and exits with the documented code", async () => {
		const { code, stdout, stderr } = await spawnCli({
			argv: ["validate"],
		})

		expect([0, 4], `unexpected exit ${code}; stderr=${stderr}`).toContain(code)
		expect(stdout).toMatch(/discovered \d+ module\(s\)/)
		expect(stdout).toMatch(/validation: (PASS|FAIL)/)
	})
})

// ===========================================================================
// VAL-CLI-029  validate --json emits the documented contract
// ===========================================================================

describe("VAL-CLI-029 baka validate --json", () => {
	it("emits {modulesDiscovered, validation} with modulesDiscovered===3 from BAKA_REPO", async () => {
		const { code, stdout, stderr } = await spawnCli({
			argv: ["validate", "--json"],
		})

		expect([0, 4], `unexpected exit ${code}; stderr=${stderr}`).toContain(code)

		const parsed = JSON.parse(stdout) as {
			modulesDiscovered: number
			validation: { kind: string; diagnostics?: unknown[] }
		}
		expect(parsed.modulesDiscovered).toBe(3)
		expect(parsed.validation).toBeDefined()
		expect(["pass", "fail"]).toContain(parsed.validation.kind)

		if (parsed.validation.kind === "fail") {
			expect(Array.isArray(parsed.validation.diagnostics)).toBe(true)
			expect(parsed.validation.diagnostics?.length).toBeGreaterThan(0)
		}
	})
})

// ===========================================================================
// VAL-CLI-030  validate from an empty cwd reports 0 modules
// ===========================================================================

describe("VAL-CLI-030 baka validate from empty cwd", () => {
	it("reports `discovered 0 module(s)` and exits 0", async () => {
		const { code, stdout, stderr } = await spawnCli({
			argv: ["validate"],
			cwd: EMPTY_CWD,
		})

		expect(code, `unexpected exit ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toMatch(/discovered 0 module\(s\)/)
		expect(stdout).toMatch(/validation: PASS/)
	})
})

// ===========================================================================
// VAL-ROLE-010  baka plan with worker configured but validator missing
// ===========================================================================

describe("VAL-ROLE-010 baka plan with worker configured but validator missing", () => {
	it("succeeds (or fails for non-validator reasons) when validator role is absent", async () => {
		const scratch = prepareScratchWithModules("baka-plan-worker-only-")
		const llm = await startSharedFakeLLM([planResponse("probe-worker-only")])

		try {
			const { code, stdout, stderr } = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project"],
				cwd: scratch,
				env: {},
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
				timeoutMs: 30_000,
			})

			// The plan command should NOT complain about a missing
			// validator. The validator role is only required by sdd
			// module validators. The plan command itself only needs
			// the worker role to call the LLM.
			// Acceptable outcomes: exit 0 (plan succeeded), exit 2
			// (engine error from the LLM/apply path), or exit 4
			// (validation error). The KEY assertion: stderr does NOT
			// contain the missing-validator error.
			expect(
				stderr.includes("missing LLM config: validator role not configured"),
				`unexpected missing-validator error; stderr=${stderr}`,
			).toBe(false)
			// Sanity: the worker was actually called (so we know the
			// plan path actually exercised the worker role, not just
			// short-circuited).
			expect(llm.calls).toBeGreaterThanOrEqual(1)
			// The plan command should not exit with a config error code.
			// We accept 0 or 2 here (2 = engine error from plan/apply, not
			// from config validation).
			expect([0, 2], `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toContain(code)
		} finally {
			// close handled by afterEach
		}
	}, 60_000)
})

// ===========================================================================
// VAL-ROLE-011  baka validate -m sdd with validator missing
// ===========================================================================

describe("VAL-ROLE-011 baka validate -m sdd with validator missing", () => {
	it("exits 1 with `missing LLM config: validator role not configured`", async () => {
		const scratch = prepareScratchWithModules("baka-validate-sdd-no-validator-")
		// Seed all three spec files so the constitutionCoherent structural
		// checks pass. The validator then reaches the validator-role LLM
		// call and throws because the validator role is not configured.
		const specsDir = join(scratch, "specs")
		mkdirSync(specsDir, { recursive: true })
		writeFileSync(join(specsDir, "mission.md"), "# Foo — Mission\n\nConcrete mission content.\n")
		writeFileSync(join(specsDir, "tech-stack.md"), "# Foo — Tech Stack\n\nConcrete tech stack content.\n")
		writeFileSync(join(specsDir, "roadmap.md"), "# Foo — Roadmap\n\n## Phase 1\n- Build the thing\n")
		const fakeHome = trackDir(makeEmptyDir("baka-validate-sdd-no-validator-home-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://worker.invalid/v1", model: "worker-model" },
		})

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["--cwd", scratch, "validate", "-m", "sdd"],
			fakeHome,
			cwd: scratch,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain("missing LLM config: validator role not configured")
	})
})

// ===========================================================================
// VAL-ROLE-012  baka plan with no role configured
// ===========================================================================

describe("VAL-ROLE-012 baka plan with no role configured", () => {
	it("exits 1 with `missing LLM config: worker role not configured`", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-plan-no-roles-"))
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["plan", "scaffold a TS project"],
			fakeHome,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain("missing LLM config: worker role not configured")
	})
})

// ===========================================================================
// Sanity: the scratch-dir symlinks are real symlinks (not copies)
// ===========================================================================

describe("engine smoke scratch-dir setup", () => {
	it("prepareScratchWithModules creates symlinks to BAKA_REPO/modules", () => {
		const scratch = prepareScratchWithModules("baka-scratch-sanity-")
		for (const mod of ["baka-base", "sdd", "ts-style"]) {
			const link = join(scratch, "modules", mod)
			expect(existsSync(link), `${mod} symlink missing`).toBe(true)
			expect(lstatSync(link).isSymbolicLink(), `${mod} is not a symlink`).toBe(true)
		}
	})
})

// ===========================================================================
// VAL-CLI-031  validate -m <name> --json runs a single module's validators
// ===========================================================================

describe("VAL-CLI-031 baka validate -m baka-base --json", () => {
	it("emits JSON with moduleName=baka-base and runs only baka-base validators", async () => {
		const scratch = prepareScratchWithModules("baka-validate-m-found-")
		const { code, stdout, stderr } = await spawnCli({
			argv: ["--cwd", scratch, "validate", "-m", "baka-base", "--json"],
			cwd: scratch,
		})

		expect([0, 4], `unexpected exit ${code}; stderr=${stderr}`).toContain(code)
		const parsed = JSON.parse(stdout) as {
			modulesDiscovered: number
			moduleName?: string
			validation: { kind: string; diagnostics?: unknown[] }
		}
		expect(parsed.moduleName).toBe("baka-base")
		expect(parsed.validation).toBeDefined()
		expect(["pass", "fail"]).toContain(parsed.validation.kind)
	})
})

// ===========================================================================
// VAL-CLI-032  validate -m <nonexistent> exits 1
// ===========================================================================

describe("VAL-CLI-032 baka validate -m nonexistent", () => {
	it("exits 1 with 'module not found' message (no stack frames)", async () => {
		const { code, stdout, stderr } = await spawnCli({
			argv: ["validate", "-m", "nonexistent"],
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain('module "nonexistent" not found')
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})
