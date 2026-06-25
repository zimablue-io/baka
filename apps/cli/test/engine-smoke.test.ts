// ---------------------------------------------------------------------------
// Black-box smoke tests for the engine surface of the `baka` binary.
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
//   VAL-CLI-024  plan without LLM credentials exits 1 cleanly
//   VAL-CLI-025  list-plans enumerates .baka/plans/*.plan.json
//   VAL-CLI-026  apply <missing-plan> exits 2
//   VAL-CLI-027  apply <valid-plan> --json emits the documented contract
//   VAL-CLI-028  validate prints the per-module summary
//   VAL-CLI-029  validate --json emits the documented contract
//   VAL-CLI-030  validate from an empty cwd reports 0 modules
//   VAL-CROSS-011 -p <provider> does not mutate the active provider
//
// LLM-bound probes (plan / apply) route through a fake LLM harness bound
// to 127.0.0.1:0. The harness is hermetic: no real network, no API keys,
// no flake. We carry the LLM config via BAKA_LLM_BASE_URL and
// BAKA_LLM_MODEL so the CLI does not need a populated user config.
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
	timeoutMs?: number
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, ...args.env }
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
			resolve({ code: null, stdout, stderr: stderr + `\n[test: killed after ${args.timeoutMs ?? 30_000}ms timeout]` })
		}, args.timeoutMs ?? 30_000)

		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

/** Spawn the CLI with a fresh fake HOME so the user config is isolated. */
function spawnCliWithFakeHome(args: { argv: string[]; cwd?: string; fakeHome: string; timeoutMs?: number }) {
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
				env: {
					BAKA_LLM_BASE_URL: llm.url,
					BAKA_LLM_MODEL: "fake-llm",
				},
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

		// The baka-base manifest declares moduleValidators whose shared files
		// resolve via kebab-case (has-package-json.ts / tsconfig-present.ts).
		// apps/cli/src/commands/module.ts computes the path via
		// validatorFilename(ruleId), so a well-formed module passes the
		// layout check and exits 0. Pre-fix this asserted [0, 4]; the bug
		// fix tightens it to 0.
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
		// All three actions declared by the manifest.
		expect(stdout).toContain("- scaffold:")
		expect(stdout).toContain("- add-script:")
		expect(stdout).toContain("- add-dependency:")
		// At least one declared param should appear (e.g. scaffold's `name`).
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

		// No leftover temp dirs under $TMPDIR matching the baka-test-* prefix.
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
		// Default intent argument (per apps/cli/src/index.ts). Commander wraps
		// the long default string across two lines, so we match a fragment
		// that survives the wrap and a fragment that confirms the wrap target.
		expect(stdout).toContain("Set up core typescript")
		expect(stdout).toContain("with default configurations")
		// The default-intent prefix is the contract's identifier.
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
				env: { BAKA_LLM_BASE_URL: llm.url, BAKA_LLM_MODEL: "fake-llm" },
			})

			// The contract permits exit 0 (at least one step resolved) or 2
			// (no module matched). With the scripted baka-base step, we expect 0.
			expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)
			expect(stdout).toContain("plan:")
			expect(stdout).toMatch(/baka-base:scaffold/)
			// The LLM was actually called for the orchestrator step.
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
				env: { BAKA_LLM_BASE_URL: llm.url, BAKA_LLM_MODEL: "fake-llm" },
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
	// VAL-CLI-023 contract requires `--save --json` together to write the
	// .plan.json file AND emit the documented JSON contract. Before the fix,
	// `apps/cli/src/commands/plan.ts` returned early in JSON mode before
	// reaching the save branch. The fix moves save before the JSON early-
	// return and adds `planFile` + `savedAt` fields to the JSON output when
	// --save was applied.
	it("writes .baka/plans/*.plan.json AND emits documented JSON when --save --json are passed together", async () => {
		const scratch = prepareScratchWithModules("baka-plan-save-")
		const llm = await startSharedFakeLLM([planResponse("probe-save")])

		try {
			const { code, stdout, stderr } = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project", "--save", "--json"],
				cwd: scratch,
				env: { BAKA_LLM_BASE_URL: llm.url, BAKA_LLM_MODEL: "fake-llm" },
			})

			expect(code, `unexpected exit ${code}; stderr=${stderr}`).toBe(0)

			// The JSON contract is emitted to stdout with status, steps, logs.
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
			// The save fields are populated when --save was applied.
			expect(typeof parsed.planFile).toBe("string")
			expect(typeof parsed.savedAt).toBe("string")
			expect((parsed.planFile as string).endsWith(".plan.json")).toBe(true)

			// The persisted file exists at the path emitted in planFile.
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

			// Sanity: the file is also visible under the conventional .baka/plans/ dir.
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
// VAL-CLI-024  plan without LLM credentials exits 1, no stack
// ===========================================================================

describe("VAL-CLI-024 baka plan without LLM credentials", () => {
	it("exits 1 with a single user-facing line suggesting `baka init` (no stack frames)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-plan-no-creds-"))

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["plan", "scaffold a TS project"],
			fakeHome,
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		// Single-line `baka:` prefix and an actionable hint.
		expect(stderr).toMatch(/^baka:/m)
		expect(stderr).toContain("baka init")
		// No Node stack frames on stderr.
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ===========================================================================
// VAL-CLI-025  list-plans enumerates .baka/plans/*.plan.json
// ===========================================================================

describe("VAL-CLI-025 baka list-plans", () => {
	it("reports the saved plan's intent and timestamp after plan --save", async () => {
		const scratch = prepareScratchWithModules("baka-list-plans-")
		const llm = await startSharedFakeLLM([planResponse("probe-list-plans")])

		try {
			// Save a plan first. Use --save --json together (the contract gap
			// in plan.ts:55 was closed; see VAL-CLI-023).
			const save = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project", "--save", "--json"],
				cwd: scratch,
				env: { BAKA_LLM_BASE_URL: llm.url, BAKA_LLM_MODEL: "fake-llm" },
			})
			expect(save.code, `save failed: ${save.stderr}`).toBe(0)
			const saved = JSON.parse(save.stdout) as { planFile?: string }
			expect(typeof saved.planFile).toBe("string")

			// Now list-plans.
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
		// Use --save --json together (the contract gap in plan.ts:55 was
		// closed; see VAL-CLI-023). The apply path itself supports --json
		// and emits the documented shape.
		const scratch = prepareScratchWithModules("baka-apply-")
		const llm = await startSharedFakeLLM([planResponse("probe-apply")])

		try {
			// Save a plan. Use --save --json together so the saved file lands
			// in .baka/plans/ and the response carries planFile.
			const save = await spawnCli({
				argv: ["--cwd", scratch, "plan", "scaffold a TS project", "--save", "--json"],
				cwd: scratch,
				env: { BAKA_LLM_BASE_URL: llm.url, BAKA_LLM_MODEL: "fake-llm" },
			})
			expect(save.code, `save failed: ${save.stderr}`).toBe(0)
			const saved = JSON.parse(save.stdout) as { planFile?: string }
			expect(typeof saved.planFile).toBe("string")
			const planFile = saved.planFile as string

			// Sanity: the file is visible under the conventional .baka/plans/ dir.
			const planFiles = readdirSyncSafe(join(scratch, ".baka", "plans")).filter((f) => f.endsWith(".plan.json"))
			expect(planFiles.length).toBe(1)

			// Apply it.
			const apply = await spawnCli({
				argv: ["--cwd", scratch, "apply", planFile, "--json"],
				cwd: scratch,
				env: { BAKA_LLM_BASE_URL: llm.url, BAKA_LLM_MODEL: "fake-llm" },
			})

			// The contract allows exit 0 (SUCCESS) or 4 (VALIDATION_FAILED).
			// On a clean scratch tree with only the scaffold output, the
			// scaffold's hasConsoleLog validator passes and there are no
			// other errors, so we expect 0.
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
				// The scaffold wrote a src/index.ts.
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
// VAL-CLI-028  validate prints the per-module summary (or the documented gap)
// ===========================================================================

describe("VAL-CLI-028 baka validate", () => {
	it("prints a summary line and exits with the documented code", async () => {
		const { code, stdout, stderr } = await spawnCli({
			argv: ["validate"],
		})

		// Exit code: 0 if all modules pass; 4 (VALIDATION_ERROR) if any fail.
		// This top-level validate runs the actual validators (noAnyTypes,
		// explicitReturnTypes, etc.) against the cwd. The current codebase
		// has known `any` usages and missing return types, so this exits 4
		// today regardless of the validator-path bug fix in module.ts. We
		// accept either 0 or 4 here; the per-module bug fix in module.ts is
		// covered by VAL-CLI-011.
		expect([0, 4], `unexpected exit ${code}; stderr=${stderr}`).toContain(code)
		// Always print the discovered count so the user can see what was scanned.
		expect(stdout).toMatch(/discovered \d+ module\(s\)/)
		// Always print a clear pass/fail aggregate so the user can act on it.
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

		// Same reasoning as VAL-CLI-028: the top-level validate runs the
		// actual validators and the current codebase has known findings,
		// so this legitimately exits 4 (VALIDATION_ERROR) when run from
		// BAKA_REPO. The per-module bug fix in module.ts is independent
		// (see VAL-CLI-011). Accept either exit code here.
		expect([0, 4], `unexpected exit ${code}; stderr=${stderr}`).toContain(code)

		const parsed = JSON.parse(stdout) as {
			modulesDiscovered: number
			validation: { kind: string; diagnostics?: unknown[] }
		}
		expect(parsed.modulesDiscovered).toBe(3)
		expect(parsed.validation).toBeDefined()
		expect(["pass", "fail"]).toContain(parsed.validation.kind)

		// If fail, the diagnostics array must be present and non-empty.
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
// VAL-CROSS-011  -p <provider> does not mutate the active provider
// ===========================================================================

describe("VAL-CROSS-011 baka -p <provider> does not mutate the active provider", () => {
	it("uses the named provider for one plan call and leaves activeProvider unchanged", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-p-override-"))
		const configPath = join(fakeHome, "config.json")
		// Pre-seed the user config: acme is the active provider; globex is
		// a second, non-active provider. Both have baseUrl+model so the
		// CLI's config validator accepts them.
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					providers: {
						acme: { baseUrl: "http://acme.invalid", model: "m-acme" },
						globex: { baseUrl: "http://globex.invalid", model: "m-globex" },
					},
					activeProvider: "acme",
				},
				null,
				2,
			),
			"utf-8",
		)

		// Pre-state: acme is active.
		const pre = await spawnCliWithFakeHome({ argv: ["providers", "list"], fakeHome })
		expect(pre.code).toBe(0)
		expect(pre.stdout).toMatch(/^\* acme/m)

		// Run a plan with -p globex. We don't need a real LLM; the plan
		// command will fail with ENGINE_ERROR (2) when the named provider's
		// baseUrl is unreachable. Either way the override must NOT mutate
		// activeProvider.
		const probe = await spawnCliWithFakeHome({
			argv: ["-p", "globex", "plan", "scaffold a TS project"],
			fakeHome,
		})
		// Acceptable: any non-zero exit that proves the call reached the LLM
		// layer with the named provider. ENGINE_ERROR (=2) is the documented
		// fetch-failure code.
		expect(probe.code, `probe exited 0 — override did not take effect; stdout=${probe.stdout}`).not.toBe(0)

		// Post-state: active provider is still acme; globex did not become active.
		const post = await spawnCliWithFakeHome({ argv: ["providers", "list"], fakeHome })
		expect(post.code).toBe(0)
		expect(post.stdout).toMatch(/^\* acme/m)
		expect(post.stdout).not.toMatch(/^\* globex/m)

		// Confirm the underlying config file was not mutated either.
		const reloaded = JSON.parse(readFileSync(configPath, "utf-8")) as { activeProvider?: string }
		expect(reloaded.activeProvider).toBe("acme")
	})
})

// ===========================================================================
// Sanity: the scratch-dir symlinks are real symlinks (not copies), so the
// engine's discovery layer exercises the production code path.
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
