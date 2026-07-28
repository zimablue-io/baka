// ---------------------------------------------------------------------------
// Foundation-fix tests for MCP baka_plan / baka_apply honesty.
//
// Every probe spawns the BUILT MCP server (`apps/mcp/dist/index.js`) over
// stdio, sends raw JSON-RPC frames, and inspects the filesystem. The tests
// assert that baka_plan never mutates the project tree, that save:true honors
// the flag, and that baka_apply is the only execution path.
//
// Coverage map (validation-contract.md):
//   VAL-FOUND-003  MCP baka_plan never mutates the tree (dryRun:true and default)
//   VAL-FOUND-004  MCP baka_plan description honesty
//   VAL-FOUND-006  MCP baka_plan save:true persists a loadable plan
//   VAL-FOUND-008  MCP baka_apply executes a saved plan
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "mcp", "dist", "index.js")
const HONEST_MOD_FIXTURE = join(BAKA_REPO, "apps", "cli", "test", "fixtures", "honest-mod")

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

function spawnMcp(cwd: string, baseUrl: string, model: string): SpawnedMcp {
	const home = mkdtempSync(join(tmpdir(), "baka-mcp-honesty-home-"))
	createdDirs.push(home)
	seedRoleConfig(home, baseUrl, model)
	const child: ChildProcess = spawn("node", [DIST_INDEX], {
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

function sendRpc(state: SpawnedMcp, method: string, params?: unknown, id?: number): number {
	const useId = id ?? state.nextId++
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

async function initialize(state: SpawnedMcp): Promise<JsonRpcResponse> {
	const id = sendRpc(state, "initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "baka-mcp-plan-honesty", version: "0.0.0" },
	})
	const resp = await waitForResponse(state, id, 5_000)
	if (!resp) throw new Error("initialize: no response")
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

function makeEmptyDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

function prepareScratchWithFixture(prefix: string): string {
	const scratch = trackDir(makeEmptyDir(prefix))
	mkdirSync(join(scratch, "modules"), { recursive: true })
	symlinkSync(HONEST_MOD_FIXTURE, join(scratch, "modules", "honest-mod"))
	return scratch
}

interface TreeEntry {
	path: string
	hash: string
}

function snapshotTree(root: string): TreeEntry[] {
	const entries: TreeEntry[] = []
	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name)
			const rel = relative(root, full)
			if (entry.isDirectory()) {
				walk(full)
			} else if (entry.isFile()) {
				entries.push({ path: rel, hash: createHash("sha256").update(readFileSync(full)).digest("hex") })
			}
		}
	}
	if (existsSync(root)) walk(root)
	entries.sort((a, b) => a.path.localeCompare(b.path))
	return entries
}

function treeDiff(
	before: TreeEntry[],
	after: TreeEntry[],
	ignore?: (relPath: string) => boolean,
): { added: TreeEntry[]; removed: TreeEntry[]; changed: { before: TreeEntry; after: TreeEntry }[] } {
	const beforeBy = new Map(before.map((e) => [e.path, e]))
	const afterBy = new Map(after.map((e) => [e.path, e]))
	const added: TreeEntry[] = []
	const removed: TreeEntry[] = []
	const changed: { before: TreeEntry; after: TreeEntry }[] = []
	for (const [path, afterEntry] of afterBy) {
		if (ignore?.(path)) continue
		const beforeEntry = beforeBy.get(path)
		if (!beforeEntry) added.push(afterEntry)
		else if (beforeEntry.hash !== afterEntry.hash) changed.push({ before: beforeEntry, after: afterEntry })
	}
	for (const [path, beforeEntry] of beforeBy) {
		if (ignore?.(path)) continue
		if (!afterBy.has(path)) removed.push(beforeEntry)
	}
	return { added, removed, changed }
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/")
}

function isOnlyPlanFile(path: string): boolean {
	const normalized = normalizePath(path)
	return normalized.startsWith(".baka/plans/") && normalized.endsWith(".plan.json")
}

// ---------------------------------------------------------------------------
// Test fixture prep
// ---------------------------------------------------------------------------

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built MCP not found at ${DIST_INDEX}; run \`pnpm --filter @baka/mcp-server build\` first`)
	}
})

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// VAL-FOUND-004  baka_plan description honesty
// ---------------------------------------------------------------------------

describe("VAL-FOUND-004 baka_plan tool description honesty", () => {
	it("states that the tool does not modify the project and that execution is via baka_apply", async () => {
		const scratch = prepareScratchWithFixture("baka-mcp-desc-")
		const llm = await startFakeLLM(planResponse())
		const state = spawnMcp(scratch, llm.url, "fake-llm")
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { tools: Array<{ name: string; description: string }> }
			const planTool = result.tools.find((t) => t.name === "baka_plan")
			expect(planTool).toBeDefined()
			const desc = (planTool?.description ?? "").toLowerCase()
			expect(desc).toContain("does not modify")
			expect(desc).toContain("baka_apply")
		} finally {
			await shutdown(state)
			await llm.close()
		}
	}, 30_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-003 / VAL-FOUND-006  baka_plan never mutates, save:true honored
// ---------------------------------------------------------------------------

describe("VAL-FOUND-003/006 baka_plan never mutates and save:true writes a plan", () => {
	it("leaves the tree unchanged and writes exactly one .baka/plans/*.plan.json", async () => {
		const scratch = prepareScratchWithFixture("baka-mcp-plan-save-")
		const llm = await startFakeLLM(planResponse())
		const state = spawnMcp(scratch, llm.url, "fake-llm")

		try {
			await initialize(state)
			const before = snapshotTree(scratch)

			const id = sendRpc(state, "tools/call", {
				name: "baka_plan",
				arguments: { intent: "write a marker", dryRun: true, save: true },
			})
			const resp = await waitForResponse(state, id, 60_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as { isError?: boolean; content: Array<{ type: string; text: string }> }
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				status: string
				steps: unknown[]
				planFile?: string
			}
			expect(parsed.status).toBe("SUCCESS")
			expect(parsed.steps.length).toBeGreaterThan(0)
			expect(typeof parsed.planFile).toBe("string")
			const planFile = parsed.planFile as string
			expect(existsSync(planFile)).toBe(true)
			const saved = JSON.parse(readFileSync(planFile, "utf-8")) as {
				resolvedSteps: unknown[]
				meta?: { intent: string }
			}
			expect(saved.resolvedSteps).toEqual(parsed.steps)
			expect(saved.meta?.intent).toBe("write a marker")

			const after = snapshotTree(scratch)
			const diff = treeDiff(before, after, isOnlyPlanFile)
			expect(diff.added, `tree mutated: added ${JSON.stringify(diff.added)}`).toEqual([])
			expect(diff.removed, `tree mutated: removed ${JSON.stringify(diff.removed)}`).toEqual([])
			expect(diff.changed, `tree mutated: changed ${JSON.stringify(diff.changed)}`).toEqual([])
		} finally {
			await shutdown(state)
			await llm.close()
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-008  baka_apply executes a saved plan
// ---------------------------------------------------------------------------

describe("VAL-FOUND-008 baka_apply executes a saved plan", () => {
	it("runs the saved plan through the SAGA and produces the step's output files", async () => {
		const scratch = prepareScratchWithFixture("baka-mcp-apply-")
		const llm = await startFakeLLM(planResponse())
		const state = spawnMcp(scratch, llm.url, "fake-llm")

		try {
			await initialize(state)

			const planId = sendRpc(state, "tools/call", {
				name: "baka_plan",
				arguments: { intent: "write a marker", save: true },
			})
			const planResp = await waitForResponse(state, planId, 60_000)
			expect(planResp?.error).toBeUndefined()
			const planResult = planResp?.result as { isError?: boolean; content: Array<{ type: string; text: string }> }
			expect(planResult.isError).toBeFalsy()
			const planParsed = JSON.parse(planResult.content[0].text) as { status: string; planFile?: string }
			expect(planParsed.status).toBe("SUCCESS")
			expect(typeof planParsed.planFile).toBe("string")
			const planFile = planParsed.planFile as string

			const applyId = sendRpc(state, "tools/call", {
				name: "baka_apply",
				arguments: { planFile },
			})
			const applyResp = await waitForResponse(state, applyId, 60_000)
			expect(applyResp?.error).toBeUndefined()
			const applyResult = applyResp?.result as { isError?: boolean; content: Array<{ type: string; text: string }> }
			expect(applyResult.isError).toBeFalsy()
			const applyParsed = JSON.parse(applyResult.content[0].text) as {
				status: string
				completedSteps: Array<{ module: string; action: string }>
			}
			expect(applyParsed.status).toBe("SUCCESS")
			expect(applyParsed.completedSteps.length).toBeGreaterThan(0)
			expect(applyParsed.completedSteps[0]).toMatchObject({ module: "honest-mod", action: "write" })
			expect(existsSync(join(scratch, "marker.txt"))).toBe(true)
		} finally {
			await shutdown(state)
			await llm.close()
		}
	}, 120_000)
})
