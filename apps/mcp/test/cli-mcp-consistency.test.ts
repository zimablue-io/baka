// ---------------------------------------------------------------------------
// Foundation-fix tests for CLI/MCP consistency.
//
// Every probe spawns the BUILT artifacts (`apps/mcp/dist/index.js` and
// `apps/cli/dist/index.js`) as subprocesses. The CLI is driven with
// `--json`; the MCP server is driven with raw JSON-RPC frames over stdio.
// Both surfaces share one deterministic fake LLM so the plans they return
// are directly comparable.
//
// Coverage map (validation-contract.md):
//   VAL-FOUND-041  CLI and MCP return the same plan shape for the same
//                  intent; saved plans are interchangeable via `baka apply`
//   VAL-FOUND-042  MCP validation failure is inspectable as a failure
//                  (isError set + top-level `valid: false`)
//   VAL-FOUND-058  tools/list has engine + registry tools only
//                  (no per-action tools; named actions go through `baka run`)
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { copyPlatformFixtures } from "../../cli/test/helpers/copy-fixtures"

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const MCP_DIST_INDEX = join(BAKA_REPO, "apps", "mcp", "dist", "index.js")
const CLI_DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
// Inline fixture: minimal manifest + a single non-reasoning `write` action.
// Built into the scratch tree (no symlink to a separate fixture dir, no
// `baka-sdk` import path required) so the loader sees the module just like
// any other on-disk module.
const HONEST_MOD_NAME = "honest-mod"
const HONEST_MOD_MANIFEST = `// Inline fixture: see apps/mcp/test/cli-mcp-consistency.test.ts
// for why this is inlined instead of loaded from a separate fixture file.
import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
\tname: "${HONEST_MOD_NAME}",
\tversion: "0.0.0",
\tdescription: "Inline non-reasoning fixture used by CLI/MCP parity tests.",
\tdependencies: [],
\tconflictsWith: [],
\tactions: [
\t\t{
\t\t\tid: "write",
\t\t\tdescription: "Write a marker file to the project root.",
\t\t\trequiresReasoning: false,
\t\t\tfilePatterns: ["marker.txt"],
\t\t\tvalidators: [],
\t\t\tparams: [],
\t\t},
\t],
\tmoduleValidators: [],
}
`
const HONEST_MOD_ACTION = `import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AgentRole, type StepResponse, type WorkflowStep } from "baka-sdk"

export const writeAction: WorkflowStep<Record<string, never>, boolean, { targetDirectory: string }> = {
\tname: "${HONEST_MOD_NAME}.write",
\trole: AgentRole.WORKER,

\texecute: async (_input, state): Promise<StepResponse<boolean, { targetDirectory: string }>> => {
\t\tconst targetDirectory = state.targetDirectory
\t\twriteFileSync(join(targetDirectory, "marker.txt"), "honest-mod was here\\n", "utf-8")
\t\treturn {
\t\t\tsuccess: true,
\t\t\toutput: true,
\t\t\tcompensationData: { targetDirectory },
\t\t}
\t},

\tcompensate: async (data): Promise<void> => {
\t\ttry {
\t\t\trmSync(join(data.targetDirectory, "marker.txt"), { force: true })
\t\t} catch {
\t\t\t// best effort
\t\t}
\t},
}
`
const SHIPPED_MODULES = ["honest-mod", "slot-mod"] as const
const ENGINE_TOOLS = [
	"baka_plan",
	"baka_apply",
	"baka_validate",
	"baka_list_actions",
	"baka_run",
	"baka_slots",
	"baka_fill",
] as const

interface JsonRpcResponse {
	jsonrpc: "2.0"
	id: number | string
	result?: unknown
	error?: { code: number; message: string; data?: unknown }
}

interface SpawnedMcp {
	child: ChildProcess
	stdoutBuf: string
	stderrBuf: string
	requests: JsonRpcResponse[]
	nextId: number
}

function seedRoleConfig(home: string, baseUrl: string, model: string): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify(
			{
				worker: {
					baseUrl,
					model,
					apiKey: "test-worker-key",
					temperature: 0,
					maxTokens: 8192,
					timeoutMs: 120_000,
				},
			},
			null,
			2,
		),
	)
}

function spawnMcp(cwd: string, home: string): SpawnedMcp {
	const child: ChildProcess = spawn("node", [MCP_DIST_INDEX], {
		cwd,
		env: { ...process.env, HOME: home },
		stdio: ["pipe", "pipe", "pipe"],
	})
	const state: SpawnedMcp = {
		child,
		stdoutBuf: "",
		stderrBuf: "",
		requests: [],
		nextId: 1,
	}
	child.stdout?.on("data", (b: Buffer) => {
		state.stdoutBuf += b.toString()
		for (;;) {
			const idx = state.stdoutBuf.indexOf("\n")
			if (idx === -1) break
			const line = state.stdoutBuf.slice(0, idx).trim()
			state.stdoutBuf = state.stdoutBuf.slice(idx + 1)
			if (!line) continue
			try {
				state.requests.push(JSON.parse(line) as JsonRpcResponse)
			} catch {
				// ignore
			}
		}
	})
	child.stderr?.on("data", (b: Buffer) => {
		state.stderrBuf += b.toString()
	})
	return state
}

function sendRpc(state: SpawnedMcp, method: string, params?: unknown): number {
	const useId = state.nextId++
	const frame = { jsonrpc: "2.0" as const, id: useId, method, ...(params !== undefined ? { params } : {}) }
	state.child.stdin?.write(`${JSON.stringify(frame)}\n`)
	return useId
}

async function waitForResponse(
	state: SpawnedMcp,
	id: number,
	timeoutMs = 30_000,
): Promise<JsonRpcResponse | undefined> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const found = state.requests.find((r) => r.id === id)
		if (found) return found
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	return undefined
}

async function initialize(state: SpawnedMcp): Promise<void> {
	const id = sendRpc(state, "initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "baka-mcp-consistency", version: "0.0.0" },
	})
	const resp = await waitForResponse(state, id, 5_000)
	if (!resp) throw new Error("initialize: no response")
	if (resp.error) throw new Error(`initialize: ${resp.error.message}`)
}

async function shutdown(state: SpawnedMcp): Promise<void> {
	try {
		state.child.stdin?.end()
	} catch {
		// ignore
	}
	await new Promise<void>((resolve) => {
		const t = setTimeout(() => {
			try {
				state.child.kill("SIGKILL")
			} catch {
				// ignore
			}
			resolve()
		}, 500)
		state.child.on("close", () => {
			clearTimeout(t)
			resolve()
		})
	})
}

interface CliResult {
	code: number | null
	stdout: string
	stderr: string
}

function runCli(argv: string[], opts: { cwd: string; home: string }): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = spawn("node", [CLI_DIST_INDEX, ...argv], {
			cwd: opts.cwd,
			env: { ...process.env, HOME: opts.home },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		child.on("close", (code) => resolve({ code, stdout, stderr }))
	})
}

interface FakeLLMHandle {
	url: string
	calls: number
	close(): Promise<void>
}

function startFakeLLM(content: string): Promise<FakeLLMHandle> {
	let calls = 0
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
							message: { role: "assistant", content },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
				}),
			)
		})
	})
	return new Promise((resolve, reject) => {
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || !addr) {
				reject(new Error("fake LLM: failed to bind"))
				return
			}
			resolve({
				url: `http://127.0.0.1:${addr.port}/v1`,
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

function planResponse(): string {
	return JSON.stringify({
		resolvedSteps: [
			{
				id: "step-1",
				module: "honest-mod",
				action: "write",
				params: {},
			},
		],
	})
}

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

function makeEmptyDir(prefix: string): string {
	return trackDir(mkdtempSync(join(tmpdir(), prefix)))
}

/** Isolated HOME with the worker role pointed at the fake LLM. */
function makeHome(baseUrl: string): string {
	const home = makeEmptyDir("baka-consistency-home-")
	seedRoleConfig(home, baseUrl, "fake-llm")
	return home
}

/** Temp project exposing the honest-mod fixture via the tree scope. */
function prepareScratchWithHonestMod(prefix: string): string {
	const scratch = makeEmptyDir(prefix)
	const modDir = join(scratch, "modules", HONEST_MOD_NAME)
	mkdirSync(join(modDir, "write"), { recursive: true })
	writeFileSync(join(modDir, "manifest.ts"), HONEST_MOD_MANIFEST, "utf-8")
	writeFileSync(join(modDir, "write", "action.ts"), HONEST_MOD_ACTION, "utf-8")
	return scratch
}

/** Temp project with honest-mod and slot-mod in tree scope. */
function prepareScratchWithShippedModules(prefix: string): string {
	const scratch = makeEmptyDir(prefix)
	copyPlatformFixtures(scratch)
	return scratch
}

beforeAll(() => {
	if (!existsSync(MCP_DIST_INDEX)) {
		throw new Error(`built MCP not found at ${MCP_DIST_INDEX}; run \`pnpm --filter @baka/mcp-server build\` first`)
	}
	if (!existsSync(CLI_DIST_INDEX)) {
		throw new Error(`built CLI not found at ${CLI_DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
})

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// VAL-FOUND-041  CLI and MCP return the same plan for the same intent
// ---------------------------------------------------------------------------

describe("VAL-FOUND-041 CLI/MCP plan parity", () => {
	it("returns identical steps and shape for the same intent, and `baka apply` executes either saved file", async () => {
		const planScratch = prepareScratchWithHonestMod("baka-consistency-plan-")
		const llm = await startFakeLLM(planResponse())
		const home = makeHome(llm.url)

		// --- CLI side: `baka plan "<intent>" --json --save` --------------------
		const cli = await runCli(["plan", "write a marker", "--json", "--save"], {
			cwd: planScratch,
			home,
		})
		expect(cli.code, `CLI plan failed: ${cli.stderr}`).toBe(0)
		const cliPlan = JSON.parse(cli.stdout) as Record<string, unknown>
		expect(typeof cliPlan.planFile).toBe("string")

		// --- MCP side: `tools/call baka_plan { save: true }` -------------------
		const state = spawnMcp(planScratch, home)
		let mcpPlan: Record<string, unknown>
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_plan",
				arguments: { intent: "write a marker", save: true },
			})
			const resp = await waitForResponse(state, id, 60_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { isError?: boolean; content: Array<{ type: string; text: string }> }
			expect(result.isError).toBeFalsy()
			mcpPlan = JSON.parse(result.content[0].text) as Record<string, unknown>
		} finally {
			await shutdown(state)
		}

		// Same top-level shape and identical step content (deterministic fake).
		expect(Object.keys(mcpPlan).sort()).toEqual(Object.keys(cliPlan).sort())
		expect(mcpPlan.status).toBe("SUCCESS")
		expect(mcpPlan.status).toBe(cliPlan.status)
		expect(mcpPlan.steps).toEqual(cliPlan.steps)
		expect(typeof mcpPlan.planFile).toBe("string")

		// Interchangeability: `baka apply` executes either saved file.
		for (const [label, planFile] of [
			["cli-saved", cliPlan.planFile as string],
			["mcp-saved", mcpPlan.planFile as string],
		] as const) {
			const applyScratch = prepareScratchWithHonestMod(`baka-consistency-apply-${label}-`)
			const applied = await runCli(["apply", planFile, "--json"], { cwd: applyScratch, home })
			expect(applied.code, `${label} apply failed: ${applied.stderr}\n${applied.stdout}`).toBe(0)
			const appliedJson = JSON.parse(applied.stdout) as { status: string }
			expect(appliedJson.status, `${label} apply status`).toBe("SUCCESS")
			expect(existsSync(join(applyScratch, "marker.txt")), `${label} apply must write marker.txt`).toBe(true)
		}

		await llm.close()
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-042  MCP validation failure is inspectable as a failure
// ---------------------------------------------------------------------------

describe("VAL-FOUND-042 baka_validate failure surface", () => {
	it("sets isError and valid:false on a failing project, valid:true with no isError on a passing one", async () => {
		const home = makeHome("http://127.0.0.1:1/v1")

		// Failing project: a fixture validator that always fails.
		const failing = makeEmptyDir("baka-consistency-vfail-")
		const failMod = join(failing, "modules", "fail-mod")
		mkdirSync(join(failMod, "noop", "templates"), { recursive: true })
		writeFileSync(
			join(failMod, "manifest.ts"),
			`export const Manifest = {
  name: "fail-mod",
  version: "0.0.0",
  description: "declares a missing validator so validate fails",
  dependencies: [],
  conflictsWith: [],
  actions: [{
    id: "noop",
    description: "noop",
    params: [],
    requiresReasoning: false,
    filePatterns: [],
    validators: [],
  }],
  moduleValidators: ["missing-rule"],
}
`,
		)
		writeFileSync(join(failMod, "noop", "templates", "x.txt.hbs"), "x\n")
		const failState = spawnMcp(failing, home)
		try {
			await initialize(failState)
			const id = sendRpc(failState, "tools/call", { name: "baka_validate", arguments: {} })
			const resp = await waitForResponse(failState, id)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { isError?: boolean; content: Array<{ type: string; text: string }> }
			const parsed = JSON.parse(result.content[0].text) as {
				valid: boolean
				modulesDiscovered: number
				validation: { kind: string; diagnostics: unknown[] }
			}
			expect(parsed.validation.kind, `expected a failing fixture: ${result.content[0].text}`).toBe("fail")
			expect(parsed.validation.diagnostics.length).toBeGreaterThan(0)
			// The failure is unambiguous to an agent client: the tool result is
			// marked as an error AND the payload carries a top-level boolean.
			expect(result.isError).toBe(true)
			expect(parsed.valid).toBe(false)
		} finally {
			await shutdown(failState)
		}

		// Passing project: an empty tree with no modules has nothing to fail.
		const passing = makeEmptyDir("baka-consistency-vpass-")
		const passState = spawnMcp(passing, home)
		try {
			await initialize(passState)
			const id = sendRpc(passState, "tools/call", { name: "baka_validate", arguments: {} })
			const resp = await waitForResponse(passState, id)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { isError?: boolean; content: Array<{ type: string; text: string }> }
			const parsed = JSON.parse(result.content[0].text) as {
				valid: boolean
				validation: { kind: string }
			}
			expect(parsed.validation.kind).toBe("pass")
			expect(result.isError).toBeFalsy()
			expect(parsed.valid).toBe(true)
		} finally {
			await shutdown(passState)
		}
	}, 60_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-058  tools/list exposes one tool per action per shipped module
// ---------------------------------------------------------------------------

describe("VAL-FOUND-058 MCP has no per-action tools", () => {
	it("exposes engine + registry tools only; agents run `baka … --json` for named actions", async () => {
		const scratch = prepareScratchWithShippedModules("baka-consistency-tools-")
		const home = makeHome("http://127.0.0.1:1/v1")

		const state = spawnMcp(scratch, home)
		let toolNames: string[]
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { tools: Array<{ name: string }> }
			toolNames = result.tools.map((t) => t.name)
		} finally {
			await shutdown(state)
		}

		// The engine tools are always present and are not per-action tools.
		for (const engine of ENGINE_TOOLS) {
			expect(toolNames).toContain(engine)
		}
		// Milestone 5 mcp-registry-tools adds three registry
		// discovery tools (architecture §8 decision 9: MCP has no
		// install capability). They are NOT per-action tools, so
		// they are excluded from the parity check — the CLI's
		// `baka module list-actions` does not list them. The
		// `baka_registry_*` prefix is the convention; every new
		// registry tool must carry that prefix to land in this
		// exclusion automatically.
		const REGISTRY_TOOL_PREFIX = "baka_registry_"
		const leftover = toolNames.filter(
			(n) => !(ENGINE_TOOLS as readonly string[]).includes(n) && !n.startsWith(REGISTRY_TOOL_PREFIX),
		)
		expect(leftover).toEqual([])

		for (const mod of SHIPPED_MODULES) {
			const listed = await runCli(["module", "list-actions", mod, "--json"], { cwd: scratch, home })
			expect(listed.code, `list-actions ${mod} failed: ${listed.stderr}`).toBe(0)
			const parsed = JSON.parse(listed.stdout) as { actions: Array<{ id: string }> }
			expect(parsed.actions.length).toBeGreaterThan(0)
		}
	}, 60_000)
})
