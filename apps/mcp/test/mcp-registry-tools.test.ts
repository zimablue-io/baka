// Registry MCP tools against the test catalog fixture (`hello` / `greet`).
// Production BUILT_IN_CATALOG is empty. The seed server inserts `hello`
// for these probes only.

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { copyPlatformFixtures } from "../../cli/test/helpers/copy-fixtures"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "mcp", "dist", "index.js")
const MCP_README = join(BAKA_REPO, "apps", "mcp", "README.md")
const SEED_SERVER = join(BAKA_REPO, "apps", "registry", "test", "seed-publishing-server.ts")

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

function spawnMcp(opts: { cwd: string; env?: Record<string, string> }): SpawnedMcp {
	const child: ChildProcess = spawn("node", [DIST_INDEX], {
		cwd: opts.cwd,
		env: { ...process.env, ...(opts.env ?? {}) },
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
				// ignore non-JSON log lines
			}
		}
	})
	child.stderr?.on("data", (b: Buffer) => {
		state.stderrBuf += b.toString()
	})
	return state
}

function sendRpc(state: SpawnedMcp, method: string, params?: unknown): number {
	const id = state.nextId++
	const frame = { jsonrpc: "2.0" as const, id, method, ...(params !== undefined ? { params } : {}) }
	state.child.stdin?.write(`${JSON.stringify(frame)}\n`)
	return id
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
		clientInfo: { name: "baka-mcp-registry-tools", version: "0.0.0" },
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

function pickBoundThenClosedPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = net.createServer()
		probe.on("error", reject)
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address()
			if (typeof addr !== "object" || addr === null) {
				probe.close()
				reject(new Error("could not pick ephemeral port"))
				return
			}
			const port = addr.port
			probe.close(() => resolve(port))
		})
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

function fixtureProject(prefix: string): string {
	const dir = makeEmptyDir(prefix)
	copyPlatformFixtures(dir)
	return dir
}

function writeProjectSettings(cwd: string, body: string): void {
	const dir = join(cwd, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "settings.json"), body)
}

interface SeedServer {
	baseUrl: string
	stop: () => Promise<void>
}

async function bootSeedServer(): Promise<SeedServer> {
	const dataDir = makeEmptyDir("baka-mcp-registry-tools-data-")
	const port = await pickBoundThenClosedPort()
	const logPath = join(dataDir, "server.log")
	const logFd = openSync(logPath, "w")
	const child = spawn("npx", ["tsx", SEED_SERVER], {
		cwd: BAKA_REPO,
		env: {
			...process.env,
			HTTP_PORT: String(port),
			DATA_DIR: dataDir,
			SEED_CREDS_FILE: join(dataDir, "creds.json"),
			REGISTRY_API_KEY_RATE_LIMIT: "off",
		},
		stdio: ["ignore", logFd, logFd],
	})
	const baseUrl = `http://127.0.0.1:${port}`
	const credsPath = join(dataDir, "creds.json")
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/healthz`)
			if (res.ok && existsSync(credsPath)) break
		} catch {
			// not ready
		}
		await new Promise((r) => setTimeout(r, 200))
	}
	if (!existsSync(credsPath)) {
		try {
			child.kill("SIGKILL")
		} catch {
			// ignore
		}
		throw new Error(`seed server did not write creds file at ${credsPath}; log=${logPath}`)
	}
	return {
		baseUrl,
		stop: async () => {
			const pid = child.pid
			if (pid !== undefined) {
				try {
					process.kill(-pid, "SIGTERM")
				} catch {
					try {
						child.kill("SIGTERM")
					} catch {
						// best effort
					}
				}
			}
			await new Promise((r) => setTimeout(r, 500))
		},
	}
}

let server: SeedServer | null = null

beforeAll(async () => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built MCP dist not found at ${DIST_INDEX}; run \`pnpm --filter @baka/mcp-server build\` first`)
	}
	server = await bootSeedServer()
}, 120_000)

afterAll(async () => {
	if (server) {
		await server.stop()
		server = null
	}
	for (const d of createdDirs.splice(0)) {
		if (existsSync(d)) rmSync(d, { recursive: true, force: true })
	}
}, 30_000)

describe("registry tools/list", () => {
	it("registers the three discovery tools with described input schemas", async () => {
		const cwd = makeEmptyDir("baka-mcp-rt-list-")
		const state = spawnMcp({ cwd })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
			}
			const toolNames = result.tools.map((t) => t.name)
			expect(toolNames).toContain("baka_registry_search")
			expect(toolNames).toContain("baka_registry_get_module")
			expect(toolNames).toContain("baka_registry_get_preview")
			expect(toolNames).not.toContain("baka_install")

			for (const name of ["baka_registry_search", "baka_registry_get_module", "baka_registry_get_preview"] as const) {
				const tool = result.tools.find((t) => t.name === name)
				expect(tool, `${name} not in tools/list`).toBeDefined()
				expect(tool?.inputSchema.type).toBe("object")
				const props = (tool?.inputSchema.properties ?? {}) as Record<string, { description?: unknown }>
				for (const [propName, propSchema] of Object.entries(props)) {
					expect(typeof propSchema.description, `${name}.properties.${propName}.description`).toBe("string")
				}
				expect(tool?.description).toContain("baka install")
			}

			const searchTool = result.tools.find((t) => t.name === "baka_registry_search")
			expect((searchTool?.inputSchema.required ?? []) as string[]).toContain("query")
		} finally {
			await shutdown(state)
		}
	})
})

describe("baka_registry_search against the hello fixture", () => {
	it("returns hello with official tier and a greet action on get_module", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = makeEmptyDir("baka-mcp-rt-search-")
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: server.baseUrl } })
		try {
			await initialize(state)
			const searchId = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "hello" },
			})
			const searchResp = await waitForResponse(state, searchId, 10_000)
			expect(searchResp?.error).toBeUndefined()
			const searchResult = searchResp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			expect(searchResult.isError).toBeFalsy()
			const searched = JSON.parse(searchResult.content[0].text) as {
				query: string
				results: Array<{ name: string; scope: string; tier: string; description: string; registry: string }>
			}
			expect(searched.query).toBe("hello")
			expect(searched.results.map((r) => r.name)).toContain("hello")
			const hello = searched.results.find((r) => r.name === "hello")
			expect(hello?.scope).toBe("baka")
			expect(hello?.tier).toBe("official")
			expect(hello?.registry).toBe(server.baseUrl)

			const getId = sendRpc(state, "tools/call", {
				name: "baka_registry_get_module",
				arguments: { scope: "baka", name: "hello" },
			})
			const getResp = await waitForResponse(state, getId, 10_000)
			const getResult = getResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(getResult.isError).toBeFalsy()
			const detail = JSON.parse(getResult.content[0].text) as {
				name: string
				manifest: { actions: Array<{ id: string }> } | null
				screening: unknown
			}
			expect(detail.name).toBe("hello")
			expect(detail.screening).toBeNull()
			expect((detail.manifest?.actions ?? []).map((a) => a.id)).toEqual(["greet"])
		} finally {
			await shutdown(state)
		}
	})

	it("returns empty results for a query that matches nothing", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = makeEmptyDir("baka-mcp-rt-search-empty-")
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: server.baseUrl } })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "xxx-no-such-module-zzz" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			const result = resp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as { results: unknown[]; warnings: unknown[] }
			expect(parsed.results).toEqual([])
			expect(parsed.warnings).toEqual([])
		} finally {
			await shutdown(state)
		}
	})
})

describe("baka_registry_get_module / get_preview unknown names", () => {
	it("marks unknown modules as isError with a named not-found message", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = makeEmptyDir("baka-mcp-rt-nf-")
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: server.baseUrl } })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_get_module",
				arguments: { scope: "baka", name: "does-not-exist-zzz" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			const result = resp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(result.isError).toBe(true)
			expect(result.content[0].text.toLowerCase()).toContain("does-not-exist-zzz")
			expect(result.content[0].text).toMatch(/not found/i)
		} finally {
			await shutdown(state)
		}
	})

	it("returns an empty previews list for hello (no screening artifacts)", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = makeEmptyDir("baka-mcp-rt-preview-")
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: server.baseUrl } })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_get_preview",
				arguments: { scope: "baka", name: "hello", version: "0.1.0" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			const result = resp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as { name: string; previews: unknown[] }
			expect(parsed.name).toBe("hello")
			expect(parsed.previews).toEqual([])
		} finally {
			await shutdown(state)
		}
	})
})

describe("registry down", () => {
	it("search names the unreachable URL and the server stays alive", async () => {
		const deadPort = await pickBoundThenClosedPort()
		const cwd = makeEmptyDir("baka-mcp-rt-down-")
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: `http://127.0.0.1:${deadPort}` } })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "anything" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			const result = resp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(result.isError).toBe(true)
			expect(result.content[0].text).toContain(`http://127.0.0.1:${deadPort}`)
			expect(result.content[0].text.toLowerCase()).toMatch(/unreachable|connection refused|failed/i)
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

describe("registry config chain (env > project settings)", () => {
	it("BAKA_REGISTRY_URL wins over a dead project setting", async () => {
		if (!server) throw new Error("seed server not booted")
		const deadPort = await pickBoundThenClosedPort()
		const cwd = makeEmptyDir("baka-mcp-rt-env-")
		writeProjectSettings(cwd, JSON.stringify({ registries: [`http://127.0.0.1:${deadPort}`] }, null, 2))
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: server.baseUrl } })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "hello" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			const result = resp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				results: Array<{ name: string; registry: string }>
				warnings: Array<{ source: string }>
			}
			expect(parsed.results.some((r) => r.name === "hello")).toBe(true)
			expect(parsed.warnings.map((w) => w.source)).not.toContain(`http://127.0.0.1:${deadPort}`)
		} finally {
			await shutdown(state)
		}
	})

	it("project settings are used when env is unset", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = makeEmptyDir("baka-mcp-rt-settings-")
		writeProjectSettings(cwd, JSON.stringify({ registries: [server.baseUrl] }, null, 2))
		const state = spawnMcp({ cwd })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "hello" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			const result = resp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as { results: Array<{ name: string }> }
			expect(parsed.results.some((r) => r.name === "hello")).toBe(true)
		} finally {
			await shutdown(state)
		}
	})

	it("dead registry does not stop local list-actions against a fixture project", async () => {
		const deadPort = await pickBoundThenClosedPort()
		const cwd = fixtureProject("baka-mcp-rt-local-")
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: `http://127.0.0.1:${deadPort}` } })
		try {
			await initialize(state)
			const searchId = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "x" },
			})
			const searchResp = await waitForResponse(state, searchId, 10_000)
			const searchResult = searchResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(searchResult.isError).toBe(true)

			const listId = sendRpc(state, "tools/call", {
				name: "baka_list_actions",
				arguments: { module: "honest-mod" },
			})
			const listResp = await waitForResponse(state, listId, 10_000)
			const listResult = listResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(listResult.isError).toBeFalsy()
			const parsed = JSON.parse(listResult.content[0].text) as { module: string; actions: unknown[] }
			expect(parsed.module).toBe("honest-mod")
			expect(parsed.actions.length).toBeGreaterThan(0)
		} finally {
			await shutdown(state)
		}
	})
})

describe("discovery is read-only", () => {
	it("registry tool calls do not write into cwd", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = makeEmptyDir("baka-mcp-rt-readonly-")
		const before = readdirSync(cwd)
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: server.baseUrl } })
		try {
			await initialize(state)
			for (const call of [
				{ name: "baka_registry_search", arguments: { query: "hello" } },
				{ name: "baka_registry_get_module", arguments: { scope: "baka", name: "hello" } },
				{
					name: "baka_registry_get_preview",
					arguments: { scope: "baka", name: "hello", version: "0.1.0" },
				},
			] as const) {
				const id = sendRpc(state, "tools/call", { name: call.name, arguments: call.arguments })
				const resp = await waitForResponse(state, id, 10_000)
				expect(resp?.error).toBeUndefined()
			}
			expect(readdirSync(cwd).sort()).toEqual(before.sort())
		} finally {
			await shutdown(state)
		}
	})

	it("README names the CLI install handoff", () => {
		const readme = readFileSync(MCP_README, "utf-8")
		expect(readme).toMatch(/baka\s+install\s+@/)
		expect(readme.toLowerCase()).toMatch(/do not install|don't install|no install capability|install is the/)
	})
})

describe("bad arguments", () => {
	it("missing and wrong-type fields are isError; a later well-formed search still works", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = makeEmptyDir("baka-mcp-rt-bad-")
		const state = spawnMcp({ cwd, env: { BAKA_REGISTRY_URL: server.baseUrl } })
		try {
			await initialize(state)
			const missing = sendRpc(state, "tools/call", { name: "baka_registry_search", arguments: {} })
			const missingResp = await waitForResponse(state, missing, 10_000)
			const missingResult = missingResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(missingResult.isError).toBe(true)
			expect(missingResult.content[0].text.toLowerCase()).toContain("query")

			const ok = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "hello" },
			})
			const okResp = await waitForResponse(state, ok, 10_000)
			const okResult = okResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(okResult.isError).toBeFalsy()
		} finally {
			await shutdown(state)
		}
	})
})

describe("default registry when nothing is configured", () => {
	it("fails fast against localhost:4300 and local fixture tools still answer", async () => {
		const cwd = fixtureProject("baka-mcp-rt-default-")
		const state = spawnMcp({ cwd })
		try {
			await initialize(state)
			const startMs = Date.now()
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "anything" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(Date.now() - startMs).toBeLessThan(5_000)
			const result = resp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(result.isError).toBe(true)
			expect(result.content[0].text).toContain("http://localhost:4300")

			const listId = sendRpc(state, "tools/call", {
				name: "baka_list_actions",
				arguments: { module: "honest-mod" },
			})
			const listResp = await waitForResponse(state, listId, 10_000)
			const listResult = listResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(listResult.isError).toBeFalsy()
			expect(JSON.parse(listResult.content[0].text).module).toBe("honest-mod")
		} finally {
			await shutdown(state)
		}
	})
})
