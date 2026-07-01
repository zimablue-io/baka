// ---------------------------------------------------------------------------
// Black-box end-to-end tests for the `baka-mcp` binary.
//
// Every probe in this file spawns the BUILT artifact
// (`apps/mcp/dist/index.js`) as a subprocess over stdio, sends raw
// JSON-RPC frames, and parses the JSON-RPC responses. No in-process
// transport, no `tsx` against source. The dist binary must behave as
// documented end-to-end.
//
// Coverage map (per `validation-contract.md`):
//
//   VAL-MCP-001   initialize returns serverInfo.name === "baka-mcp"
//   VAL-MCP-002   serverInfo.version matches apps/mcp/package.json
//   VAL-MCP-003   tools/list enumerates engine + per-action (12 tools after M5)
//   VAL-MCP-004   every inputSchema has type/properties/required
//   VAL-MCP-005   per-action required arrays reflect manifest
//                  (sdd init-constitution: ["productName","summary"])
//   VAL-MCP-006   per-action enum params carry enum in schema
//                  (baka_base_scaffold.moduleType: ["esm","commonjs"])
//   VAL-MCP-007   baka_apply missing plan returns isError
//   VAL-MCP-008   baka_apply error text is parseable / stable-prefixed
//   VAL-MCP-009   baka_list_actions with known module returns actions
//   VAL-MCP-010   baka_list_actions with unknown module returns error
//   VAL-MCP-011   baka_validate returns documented shape
//   VAL-MCP-012   baka_plan dry-run shape (fake LLM)
//   VAL-MCP-013   resources/list advertises baka://modules
//   VAL-MCP-014   resources/read baka://modules returns the directory
//   VAL-MCP-015   resources/templates/list advertises manifest template
//   VAL-MCP-016   resources/read baka://module/baka-base/manifest
//   VAL-MCP-017   prompts/list advertises baka_design_module
//   VAL-MCP-018   prompts/get baka_design_module returns messages
//   VAL-MCP-019   malformed JSON-RPC does not crash the server
//   VAL-MCP-020   cwd sensitivity: 11 tools in repo, 4 in empty dir
//   VAL-MCP-021   missing required field returns schema error
//   VAL-MCP-022   unknown tool returns structured error
//   VAL-MCP-023   concurrent initialize is rejected
//   VAL-MCP-024   per-action inputSchema has description per property
//   VAL-MCP-025   one structured stderr log line per tools/call
//   VAL-CROSS-010 CLI `baka plan --json` and MCP `tools/call baka_plan`
//                  produce the same top-level JSON shape
//
// Conventions:
//   - spawn `node` against `apps/mcp/dist/index.js` (no tsx)
//   - send one JSON object per line via stdin; parse one response per line
//   - capture stderr separately so VAL-MCP-025 can grep it
//   - clean up every subprocess and fake LLM in afterEach/afterAll
//   - hermetic: bind the fake LLM to 127.0.0.1:0
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "mcp", "dist", "index.js")
const MCP_PACKAGE_JSON = join(BAKA_REPO, "apps", "mcp", "package.json")
const CLI_DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const EMPTY_CWD = join(tmpdir(), "baka-mcp-empty")

// ---------------------------------------------------------------------------
// JSON-RPC client over stdio
// ---------------------------------------------------------------------------

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

function seedBakaConfig(home: string, cfg: { baseUrl: string; model: string; apiKey?: string }) {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify(
			{
				providers: {
					"test-llm": { baseUrl: cfg.baseUrl, model: cfg.model, temperature: 0, maxTokens: 8192, timeoutMs: 120000 },
				},
				activeProvider: "test-llm",
				defaults: { temperature: 0, maxTokens: 8192, timeoutMs: 120000 },
			},
			null,
			2,
		),
	)
	if (cfg.apiKey) {
		writeFileSync(
			join(dir, "credentials"),
			JSON.stringify({ providers: { "test-llm": { apiKey: cfg.apiKey } } }, null, 2),
		)
	}
}

function spawnMcp(args: {
	cwd?: string
	env?: Record<string, string>
	timeoutMs?: number
	bakaConfig?: { baseUrl: string; model: string; apiKey?: string }
}): SpawnedMcp {
	let env: NodeJS.ProcessEnv = { ...process.env, ...args.env }
	if (args.bakaConfig) {
		const home = mkdtempSync(join(tmpdir(), "baka-mcp-home-"))
		seedBakaConfig(home, args.bakaConfig)
		env = { ...env, HOME: home }
	}
	const child: ChildProcess = spawn("node", [DIST_INDEX], {
		cwd: args.cwd ?? BAKA_REPO,
		env,
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
				const parsed = JSON.parse(line) as JsonRpcResponse
				state.requests.push(parsed)
			} catch {
				// Ignore non-JSON lines (shouldn't happen on stdout).
			}
		}
	})
	child.stderr?.on("data", (b: Buffer) => {
		state.stderrBuf += b.toString()
	})
	return state
}

function sendRpc(state: SpawnedMcp, method: string, params?: unknown, id?: number): number {
	const useId = id ?? state.nextId++
	const frame = { jsonrpc: "2.0" as const, id: useId, method, ...(params !== undefined ? { params } : {}) }
	state.child.stdin?.write(`${JSON.stringify(frame)}\n`)
	return useId
}

function sendRawFrame(state: SpawnedMcp, line: string): void {
	state.child.stdin?.write(`${line}\n`)
}

async function waitForResponse(state: SpawnedMcp, id: number, timeoutMs = 5_000): Promise<JsonRpcResponse | undefined> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const found = state.requests.find((r) => r.id === id)
		if (found) return found
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	return undefined
}

async function initialize(state: SpawnedMcp, protocolVersion = "2025-03-26"): Promise<JsonRpcResponse> {
	const id = sendRpc(state, "initialize", {
		protocolVersion,
		capabilities: {},
		clientInfo: { name: "baka-mcp-e2e", version: "0.0.0" },
	})
	const resp = await waitForResponse(state, id, 5_000)
	if (!resp) throw new Error("initialize: no response within 5s")
	return resp
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

// ---------------------------------------------------------------------------
// Fake LLM harness (OpenAI-compatible, /v1/chat/completions)
// ---------------------------------------------------------------------------

interface ScriptedResponse {
	content: string
}

interface FakeLLMHandle {
	url: string
	port: number
	calls: number
	requests: string[]
	close(): Promise<void>
}

function startFakeLLM(script: ScriptedResponse[]): Promise<FakeLLMHandle> {
	const requests: string[] = []
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
			requests.push(body)
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
				port: addr.port,
				get calls() {
					return calls
				},
				requests,
				close: () =>
					new Promise<void>((res) => {
						server.close(() => res())
					}),
			})
		})
	})
}

function planResponse(name: string, module = "baka-base", action = "scaffold"): ScriptedResponse {
	return {
		content: JSON.stringify({
			resolvedSteps: [
				{
					id: "step-1",
					module,
					action,
					params: { name, moduleType: "esm" },
				},
			],
		}),
	}
}

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

function makeEmptyDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

/** Symlink the in-repo modules into a temp scratch dir so it sees them via cwd. */
function prepareScratchWithModules(prefix: string): string {
	const scratch = trackDir(makeEmptyDir(prefix))
	mkdirSync(join(scratch, "modules"), { recursive: true })
	for (const mod of ["baka-base", "sdd", "ts-style"]) {
		const target = join(BAKA_REPO, "modules", mod)
		const link = join(scratch, "modules", mod)
		// Symlink so the module manifests resolve regardless of cwd.
		symlinkSync(target, link)
	}
	return scratch
}

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built MCP dist not found at ${DIST_INDEX}; run \`pnpm --filter @baka/mcp-server build\` first`)
	}
	if (!existsSync(EMPTY_CWD)) {
		const { mkdirSync } = require("node:fs") as typeof import("node:fs")
		mkdirSync(EMPTY_CWD, { recursive: true })
	}
})

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// VAL-MCP-001 — initialize returns serverInfo.name === "baka-mcp"
// ---------------------------------------------------------------------------

describe("VAL-MCP-001 baka-mcp initialize", () => {
	it("responds to initialize with serverInfo.name === 'baka-mcp'", async () => {
		const state = spawnMcp({})
		try {
			const resp = await initialize(state)
			expect(resp.error, `initialize returned error: ${JSON.stringify(resp.error)}`).toBeUndefined()
			const result = resp.result as { serverInfo: { name: string; version: string } }
			expect(result.serverInfo.name).toBe("baka-mcp")
			// Server stays alive for further requests.
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp).toBeDefined()
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-002 — serverInfo.version matches apps/mcp/package.json
// ---------------------------------------------------------------------------

describe("VAL-MCP-002 serverInfo.version", () => {
	it("matches apps/mcp/package.json", async () => {
		const pkg = JSON.parse(readFileSync(MCP_PACKAGE_JSON, "utf-8")) as { version: string }
		const state = spawnMcp({})
		try {
			const resp = await initialize(state)
			const result = resp.result as { serverInfo: { name: string; version: string } }
			expect(result.serverInfo.version).toBe(pkg.version)
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-003..006 — tools/list enumerates engine + per-action (11 tools)
// ---------------------------------------------------------------------------

describe("VAL-MCP-003..006 tools/list", () => {
	it("returns 11 tools: 4 engine + 8 per-action (3 baka-base + 2 sdd + 2 ts-style)", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
			const names = result.tools.map((t) => t.name).sort()
			expect(result.tools.length).toBe(11)

			// The four engine tools.
			expect(names).toContain("baka_plan")
			expect(names).toContain("baka_apply")
			expect(names).toContain("baka_validate")
			expect(names).toContain("baka_list_actions")

			// Per-action tools for the in-repo modules.
			expect(names).toContain("baka_baka_base_scaffold")
			expect(names).toContain("baka_baka_base_add_script")
			expect(names).toContain("baka_baka_base_add_dependency")
			expect(names).toContain("baka_sdd_init_constitution")
			expect(names).toContain("baka_sdd_create_feature")
			expect(names).toContain("baka_ts_style_install_config")
			expect(names).toContain("baka_ts_style_lint")
		} finally {
			await shutdown(state)
		}
	})

	it("VAL-MCP-004 every inputSchema is a valid JSON Schema (type/properties/required)", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
			for (const tool of result.tools) {
				expect(tool.inputSchema.type, `tool ${tool.name} schema.type`).toBe("object")
				expect(tool.inputSchema.properties, `tool ${tool.name} schema.properties`).toBeDefined()
				// required is optional in JSON Schema, but if present must be an array.
				if (tool.inputSchema.required !== undefined) {
					expect(Array.isArray(tool.inputSchema.required), `tool ${tool.name} schema.required`).toBe(true)
				}
			}
		} finally {
			await shutdown(state)
		}
	})

	it("VAL-MCP-005 per-action required arrays reflect the manifest", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }
			const sdd = result.tools.find((t) => t.name === "baka_sdd_init_constitution")
			expect(sdd?.inputSchema.required).toEqual(["productName", "summary"])
			const addScript = result.tools.find((t) => t.name === "baka_baka_base_add_script")
			expect(addScript?.inputSchema.required).toEqual(["name", "command"])
		} finally {
			await shutdown(state)
		}
	})

	it("VAL-MCP-006 per-action enum params carry 'enum' in the schema", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as {
				tools: Array<{
					name: string
					inputSchema: {
						properties?: Record<string, { enum?: string[] }>
					}
				}>
			}
			const scaffold = result.tools.find((t) => t.name === "baka_baka_base_scaffold")
			expect(scaffold).toBeDefined()
			expect(scaffold?.inputSchema.properties?.moduleType?.enum).toEqual(["esm", "commonjs"])
		} finally {
			await shutdown(state)
		}
	})

	it("VAL-MCP-024 every per-action property has a description field", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as {
				tools: Array<{
					name: string
					inputSchema: { properties?: Record<string, { description?: string }> }
				}>
			}
			for (const tool of result.tools) {
				const props = tool.inputSchema.properties ?? {}
				for (const [propName, propSchema] of Object.entries(props)) {
					expect(
						typeof propSchema.description === "string",
						`tool ${tool.name}.properties.${propName} missing description`,
					).toBe(true)
				}
			}
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-007..010 — tools/call happy and sad paths
// ---------------------------------------------------------------------------

describe("VAL-MCP-007/008 tools/call baka_apply missing plan", () => {
	it("returns isError:true with parseable error text naming the missing plan", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_apply",
				arguments: { planFile: "/no/such/plan.plan.json" },
			})
			const resp = await waitForResponse(state, id, 5_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { isError?: boolean; content: Array<{ type: string; text: string }> }
			expect(result.isError).toBe(true)
			expect(result.content[0].type).toBe("text")
			const text = result.content[0].text
			// The error text is either parseable JSON or carries the documented prefix.
			const isJson = (() => {
				try {
					JSON.parse(text)
					return true
				} catch {
					return false
				}
			})()
			expect(isJson || text.startsWith("plan file not found: ")).toBe(true)
			expect(text).toContain("/no/such/plan.plan.json")
			// Server stays alive: follow-up tools/list must succeed.
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

describe("VAL-MCP-009/010 tools/call baka_list_actions", () => {
	it("VAL-MCP-009 returns the declared actions for a known module", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_list_actions",
				arguments: { module: "sdd" },
			})
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				module: string
				actions: Array<{ id: string }>
			}
			expect(parsed.module).toBe("sdd")
			expect(parsed.actions.map((a) => a.id).sort()).toEqual(["create-feature", "init-constitution"])
		} finally {
			await shutdown(state)
		}
	})

	it("VAL-MCP-010 returns isError:true with a message naming the unknown module", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_list_actions",
				arguments: { module: "ghost" },
			})
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
			expect(result.isError).toBe(true)
			expect(result.content[0].text).toContain("ghost")
			// Server stays alive.
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

describe("VAL-MCP-011 tools/call baka_validate", () => {
	it("returns the documented validate contract shape", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", { name: "baka_validate", arguments: {} })
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				modulesDiscovered: number
				validation: { kind: string; diagnostics: unknown[] }
			}
			expect(typeof parsed.modulesDiscovered).toBe("number")
			expect(parsed.modulesDiscovered).toBeGreaterThanOrEqual(3)
			expect(["pass", "fail"]).toContain(parsed.validation.kind)
			expect(Array.isArray(parsed.validation.diagnostics)).toBe(true)
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-012 — tools/call baka_plan dry-run with fake LLM
// ---------------------------------------------------------------------------

describe("VAL-MCP-012 tools/call baka_plan dry-run", () => {
	it("returns a SUCCESS or FAILED plan shape (fake LLM)", async () => {
		const fake = await startFakeLLM([planResponse("probe")])
		const state = spawnMcp({
			bakaConfig: { baseUrl: fake.url, model: "fake-llm", apiKey: "fake-key" },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_plan",
				arguments: { intent: "scaffold a TS project", dryRun: true },
			})
			const resp = await waitForResponse(state, id, 30_000)
			const result = resp?.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				status: string
				steps: Array<{ module: string; action: string; params?: Record<string, unknown> }>
				logs: string[]
			}
			expect(["SUCCESS", "FAILED"]).toContain(parsed.status)
			expect(Array.isArray(parsed.steps)).toBe(true)
			expect(Array.isArray(parsed.logs)).toBe(true)
			if (parsed.status === "SUCCESS") {
				expect(parsed.steps.length).toBeGreaterThanOrEqual(1)
				expect(parsed.steps[0]?.module).toBe("baka-base")
				expect(parsed.steps[0]?.action).toBe("scaffold")
			}
			// Fake LLM was actually hit (the orchestrator runs the planning step).
			expect(fake.calls).toBeGreaterThanOrEqual(1)
		} finally {
			await shutdown(state)
			await fake.close()
		}
	}, 60_000)
})

// ---------------------------------------------------------------------------
// VAL-MCP-013/014 — resources/list + resources/read baka://modules
// ---------------------------------------------------------------------------

describe("VAL-MCP-013/014 resources/list and resources/read", () => {
	it("resources/list advertises baka://modules", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "resources/list")
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { resources: Array<{ uri: string }> }
			expect(result.resources.map((r) => r.uri)).toContain("baka://modules")
		} finally {
			await shutdown(state)
		}
	})

	it("resources/read baka://modules returns the directory JSON", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "resources/read", { uri: "baka://modules" })
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { contents: Array<{ uri: string; text: string }> }
			expect(result.contents[0].uri).toBe("baka://modules")
			const parsed = JSON.parse(result.contents[0].text) as {
				modules: Array<{ name: string; uri: string }>
			}
			expect(parsed.modules.length).toBeGreaterThanOrEqual(3)
			const names = parsed.modules.map((m) => m.name)
			expect(names).toContain("baka-base")
			expect(names).toContain("sdd")
			expect(names).toContain("ts-style")
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-015/016 — resources/templates/list and per-module manifest read
// ---------------------------------------------------------------------------

describe("VAL-MCP-015/016 resources/templates/list and per-module manifest", () => {
	it("resources/templates/list advertises the module-manifest template", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "resources/templates/list")
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { resourceTemplates: Array<{ name: string; uriTemplate: string }> }
			const templates = result.resourceTemplates
			expect(templates.length).toBeGreaterThanOrEqual(1)
			const hasManifest = templates.some((t) => /manifest/i.test(t.name) && /\{name\}/.test(t.uriTemplate))
			expect(hasManifest, `templates: ${JSON.stringify(templates)}`).toBe(true)
		} finally {
			await shutdown(state)
		}
	})

	it("resources/read baka://module/baka-base/manifest returns the manifest", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "resources/read", { uri: "baka://module/baka-base/manifest" })
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { contents: Array<{ text: string }> }
			const manifest = JSON.parse(result.contents[0].text) as {
				name: string
				version: string
				actions: Array<{ id: string }>
			}
			expect(manifest.name).toBe("baka-base")
			expect(Array.isArray(manifest.actions)).toBe(true)
			expect(manifest.actions.map((a) => a.id)).toContain("scaffold")
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-017/018 — prompts/list and prompts/get
// ---------------------------------------------------------------------------

describe("VAL-MCP-017/018 prompts/list and prompts/get", () => {
	it("prompts/list advertises baka_design_module", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "prompts/list")
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { prompts: Array<{ name: string }> }
			expect(result.prompts.map((p) => p.name)).toContain("baka_design_module")
		} finally {
			await shutdown(state)
		}
	})

	it("prompts/get baka_design_module returns messages mentioning all four phases", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "prompts/get", {
				name: "baka_design_module",
				arguments: { name: "probe" },
			})
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { messages: Array<{ role: string; content: { type: string; text: string } }> }
			expect(result.messages.length).toBeGreaterThanOrEqual(1)
			const text = result.messages.map((m) => m.content.text).join("\n")
			expect(text).toMatch(/DISCOVER/)
			expect(text).toMatch(/DEFINE/)
			expect(text).toMatch(/DEVELOP/)
			expect(text).toMatch(/DELIVER/)
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-019 — malformed JSON-RPC resilience
// ---------------------------------------------------------------------------

describe("VAL-MCP-019 malformed JSON-RPC resilience", () => {
	it("does not crash and recovers on a subsequent valid request", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			// Send invalid JSON. The transport should NOT crash the server.
			sendRawFrame(state, "this is not json")
			// Give the server a moment to process (or ignore) the bad frame.
			await new Promise((resolve) => setTimeout(resolve, 100))
			// A subsequent valid request still succeeds.
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { tools: unknown[] }
			expect(Array.isArray(result.tools)).toBe(true)
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-020 — cwd sensitivity
// ---------------------------------------------------------------------------

describe("VAL-MCP-020 cwd sensitivity", () => {
	it("sees 12 tools in BAKA_REPO and 4 engine tools in an empty dir", async () => {
		const stateRepo = spawnMcp({ cwd: BAKA_REPO })
		try {
			await initialize(stateRepo)
			const id = sendRpc(stateRepo, "tools/list")
			const resp = await waitForResponse(stateRepo, id, 5_000)
			const result = resp?.result as { tools: Array<{ name: string }> }
			expect(result.tools.length).toBe(12)
			const names = result.tools.map((t) => t.name)
			expect(names).toContain("baka_baka_base_scaffold")
		} finally {
			await shutdown(stateRepo)
		}

		const stateEmpty = spawnMcp({ cwd: EMPTY_CWD })
		try {
			await initialize(stateEmpty)
			const id = sendRpc(stateEmpty, "tools/list")
			const resp = await waitForResponse(stateEmpty, id, 5_000)
			const result = resp?.result as { tools: Array<{ name: string }> }
			// Only the 4 engine tools (no per-action tools since no modules).
			const names = result.tools.map((t) => t.name).sort()
			expect(names).toEqual(["baka_apply", "baka_list_actions", "baka_plan", "baka_validate"])
		} finally {
			await shutdown(stateEmpty)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-021 — missing required field
// ---------------------------------------------------------------------------

describe("VAL-MCP-021 tools/call missing required field", () => {
	it("returns a structured error naming the missing field; server stays alive", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_apply",
				arguments: {}, // missing planFile
			})
			const resp = await waitForResponse(state, id, 5_000)
			// The error may be surfaced as either a top-level JSON-RPC error
			// (.error) or as a tools/call result with isError:true. Both are
			// acceptable per the contract; the contract requires that the
			// message names the missing field.
			const errFromResult = (() => {
				const result = resp?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined
				if (result?.isError && result.content?.[0]?.text) {
					return { message: result.content[0].text, code: -32602 }
				}
				return undefined
			})()
			const err = resp?.error ?? errFromResult
			expect(err, `response had no error signal: ${JSON.stringify(resp)}`).toBeDefined()
			const text = err?.message ?? ""
			expect(text.toLowerCase()).toMatch(/required|invalid/)
			expect(text).toContain("planFile")
			// Server stays alive.
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-022 — unknown tool
// ---------------------------------------------------------------------------

describe("VAL-MCP-022 tools/call unknown tool", () => {
	it("returns a structured error (MethodNotFound/InvalidParams or 'unknown tool'/'not found'); server stays alive", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_ghost",
				arguments: {},
			})
			const resp = await waitForResponse(state, id, 5_000)
			const errFromResult = (() => {
				const result = resp?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined
				if (result?.isError && result.content?.[0]?.text) {
					return { message: result.content[0].text, code: -32602 }
				}
				return undefined
			})()
			const err = resp?.error ?? errFromResult
			expect(err, `response had no error signal: ${JSON.stringify(resp)}`).toBeDefined()
			const text = err?.message ?? ""
			expect(text).toMatch(/unknown tool|not found/i)
			// Server stays alive.
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-023 — concurrent initialize rejection
// ---------------------------------------------------------------------------

describe("VAL-MCP-023 concurrent initialize rejection", () => {
	it("rejects a second initialize with a structured JSON-RPC error; tools/list still works", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			// A second initialize request.
			const id = sendRpc(state, "initialize", {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "second-init", version: "0.0.0" },
			})
			const resp = await waitForResponse(state, id, 5_000)
			expect(resp?.error, `expected error on second init; got ${JSON.stringify(resp)}`).toBeDefined()
			const err = resp?.error as { code: number; message: string }
			// Contract: "the MCP spec permits this" — the error is structured,
			// not a crash. Accept any standard JSON-RPC error code; the spec
			// does not pin a single value for double-init.
			expect(typeof err.code).toBe("number")
			// Follow-up tools/list must still succeed (server stays alive).
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-MCP-025 — one structured stderr log line per tools/call
// ---------------------------------------------------------------------------

describe("VAL-MCP-025 stderr logging discipline", () => {
	it("emits one structured stderr log line per successful tools/call", async () => {
		const state = spawnMcp({})
		try {
			await initialize(state)
			// Run two tools/call probes; each must produce at least one log
			// line tagged with the tool name on stderr.
			const id1 = sendRpc(state, "tools/call", {
				name: "baka_list_actions",
				arguments: { module: "baka-base" },
			})
			const resp1 = await waitForResponse(state, id1, 5_000)
			expect(resp1?.error).toBeUndefined()

			const id2 = sendRpc(state, "tools/call", { name: "baka_validate", arguments: {} })
			const resp2 = await waitForResponse(state, id2, 5_000)
			expect(resp2?.error).toBeUndefined()

			// Give the server a tick to flush its stderr writes.
			await new Promise((resolve) => setTimeout(resolve, 50))

			// Each successful tools/call must produce ≥1 stderr log line.
			const stderr = state.stderrBuf
			const lines = stderr.split("\n").filter((l) => l.trim().length > 0)
			const bakaListLines = lines.filter((l) => l.includes("baka_list_actions"))
			const bakaValidateLines = lines.filter((l) => l.includes("baka_validate"))
			expect(
				bakaListLines.length,
				`expected ≥1 stderr line for baka_list_actions; stderr=${stderr}`,
			).toBeGreaterThanOrEqual(1)
			expect(
				bakaValidateLines.length,
				`expected ≥1 stderr line for baka_validate; stderr=${stderr}`,
			).toBeGreaterThanOrEqual(1)

			// Each line must be parseable JSON.
			for (const line of [...bakaListLines, ...bakaValidateLines]) {
				const parsed = JSON.parse(line) as Record<string, unknown>
				expect(parsed.source).toBe("baka-mcp.tool")
				expect(parsed.message).toBe("tool call")
				expect(parsed.tool).toBeTypeOf("string")
				expect(parsed.callId).toBeTypeOf("string")
				expect(["ok", "error"]).toContain(parsed.status)
			}

			// Stdout must remain pure JSON-RPC; no leakage.
			for (const line of state.stdoutBuf.split("\n")) {
				if (!line.trim()) continue
				JSON.parse(line) // throws if non-JSON; that's the assertion.
			}
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-CROSS-010 — CLI `baka plan --json` and MCP `tools/call baka_plan`
// produce the same top-level JSON shape.
// ---------------------------------------------------------------------------

describe("VAL-CROSS-010 CLI plan --json vs MCP tools/call baka_plan shape parity", () => {
	it("share the documented top-level keys (status, steps, logs)", async () => {
		const scratch = prepareScratchWithModules("baka-cross010-")
		const fake = await startFakeLLM([planResponse("probe")])

		const fakeHome = makeEmptyDir("baka-cross010-home-")
		seedBakaConfig(fakeHome, { baseUrl: fake.url, model: "fake-llm", apiKey: "fake-key" })

		// --- CLI side: `baka plan "..." --json` ---------------------------------
		const cliOut = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn("node", [CLI_DIST_INDEX, "--cwd", scratch, "plan", "scaffold a TS project", "--json"], {
				env: { ...process.env, HOME: fakeHome },
				cwd: scratch,
			})
			let stdout = ""
			let stderr = ""
			child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
			child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
			child.on("close", (code) => resolve({ code, stdout, stderr }))
		})
		const cliParsed = JSON.parse(cliOut.stdout) as Record<string, unknown>

		// --- MCP side: `tools/call baka_plan` ----------------------------------
		const state = spawnMcp({ cwd: scratch, env: { HOME: fakeHome } })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_plan",
				arguments: { intent: "scaffold a TS project", dryRun: true },
			})
			const resp = await waitForResponse(state, id, 30_000)
			const result = resp?.result as { content: Array<{ text: string }> }
			const mcpParsed = JSON.parse(result.content[0].text) as Record<string, unknown>

			// Top-level keys match: status, steps, logs. The CLI may add
			// planFile/savedAt when --save was set; without --save the shape
			// is the same as MCP. The cross-area contract asserts parity of
			// the *top-level* shape (the keys, not the values).
			const cliKeys = Object.keys(cliParsed).sort()
			const mcpKeys = Object.keys(mcpParsed).sort()

			// Required keys must be present in both.
			for (const key of ["status", "steps", "logs"]) {
				expect(cliKeys, `CLI plan output missing "${key}"`).toContain(key)
				expect(mcpKeys, `MCP baka_plan output missing "${key}"`).toContain(key)
			}

			// The types of each shared top-level key must also match.
			expect(typeof cliParsed.status).toBe(typeof mcpParsed.status)
			expect(Array.isArray(cliParsed.steps)).toBe(true)
			expect(Array.isArray(mcpParsed.steps)).toBe(true)
			expect(Array.isArray(cliParsed.logs)).toBe(true)
			expect(Array.isArray(mcpParsed.logs)).toBe(true)
		} finally {
			await shutdown(state)
			await fake.close()
		}
	}, 60_000)
})
