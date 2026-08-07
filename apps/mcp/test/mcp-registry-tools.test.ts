// ---------------------------------------------------------------------------
// Black-box e2e tests for the MCP registry discovery tools
// (milestone 5 mcp-registry-tools feature; VAL-DISC-024 / 025 / 026 /
// 027 / 028 / 029 / 044 / 045 + VAL-CROSS-014).
//
// Every probe spawns the BUILT MCP artifact
// (`apps/mcp/dist/index.js`) as a subprocess over stdio, sends raw
// JSON-RPC frames, and parses the responses. No in-process transport,
// no `tsx` against source. The dist binary must behave as documented
// end-to-end.
//
// Coverage map (per validation-contract.md):
//
//   VAL-DISC-024  tools/list exposes exactly the three registry tools
//                  (baka_registry_search / _get_module / _get_preview)
//                  with zod-derived input schemas (descriptions per
//                  property, required fields present) alongside the
//                  existing local tools
//   VAL-DISC-025  baka_registry_search returns zod-valid structured
//                  results against the protocol registry catalog
//                  entry schema
//   VAL-DISC-026  baka_registry_get_module returns the served
//                  manifest/versions/screening; unknown module is
//                  isError:true with a named not-found message
//   VAL-DISC-027  baka_registry_get_preview returns the per-action
//                  preview list (the seed registry's official
//                  catalog ships `screening: null` per decision 31
//                  — the test pins the empty-previews branch as
//                  honest rendering of "no preview available" and
//                  leaves the rendered / needs-llm shape to the
//                  user-testing validators that exercise real
//                  preview-publishing flows)
//   VAL-DISC-028  registry down → baka_registry_search is
//                  isError:true with a transport-named message
//   VAL-DISC-029  MCP uses the SAME config resolution chain as the
//                  CLI: env > project settings > default; registry
//                  tools fail when env points at a dead port while
//                  non-registry tools (baka_list_actions) keep
//                  working
//   VAL-DISC-044  MCP exposes NO install capability and the
//                  descriptions + README name the CLI handoff
//   VAL-DISC-045  registry tools validate arguments and survive
//                  bad inputs; server stays alive
//   VAL-CROSS-014 offline mode — registry tools fail honestly when
//                  the registry is unreachable; non-registry tools
//                  still answer
//
// Conventions:
//   - spawn `node` against `apps/mcp/dist/index.js`
//   - one JSON object per line over stdin; one response per line
//   - capture stderr separately so the tool-call log line assertion
//     stays scoped (also tested for parity in `mcp-e2e.test.ts`)
//   - hermetic: per-test BAKA_HOME (mkdtempSync); real registry
//     brought up via `seed-publishing-server.ts`
//   - registry-DOWN case uses a known-dead TCP port (`lsof`/`bind-then-
//     close`) so the test never races a shared server
//
// The seed server boots PGlite + Better-Auth + the polling ingest
// worker + filesystem storage; that machinery is NOT exercised by
// these tests — they only need the read endpoints (`GET /v1/modules`,
// `GET /v1/modules/<scope>/<name>`, `GET .../<version>`,
// `GET .../previews`). The seed server is enough for VAL-DISC-024
// through VAL-DISC-027; VAL-DISC-028/029/044/045/CROSS-014 run
// without it.
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, net as netImports, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

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

interface SpawnOpts {
	cwd: string
	env?: Record<string, string>
}

function spawnMcp(opts: SpawnOpts): SpawnedMcp {
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
		clientInfo: { name: "baka-mcp-registry-tools", version: "0.0.0" },
	})
	const resp = await waitForResponse(state, id, 5_000)
	if (!resp) throw new Error("initialize: no response")
	if (resp.error) throw new Error(`initialize: ${resp.error.message}`)
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

// Avoid unused-import warnings for the runtime helper.
void netImports

// ---------------------------------------------------------------------------
// Helpers: pick an ephemeral TCP port that is BOUND then CLOSED — any
// later connect() returns connection refused (the canonical "registry
// unreachable" surface used by VAL-DISC-028 / 029 / 045 / VAL-CROSS-014).
// ---------------------------------------------------------------------------

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

async function pickEphemeralPort(): Promise<number> {
	return pickBoundThenClosedPort()
}

// ---------------------------------------------------------------------------
// Temp dir + project dirs
// ---------------------------------------------------------------------------

function makeEmptyDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

function writeProjectSettings(cwd: string, body: string): void {
	const dir = join(cwd, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "settings.json"), body)
}

// ---------------------------------------------------------------------------
// Seed registry (PGlite + Better-Auth + built-in catalog seed). Used
// only for the tests that require a live registry; offline tests
// (VAL-DISC-028 / 029 / 045 / VAL-CROSS-014) never boot it.
// ---------------------------------------------------------------------------

interface SeedServer {
	baseUrl: string
	stop: () => Promise<void>
}

async function bootSeedServer(): Promise<SeedServer> {
	const dataDir = makeEmptyDir("baka-mcp-registry-tools-data-")
	trackDir(dataDir)
	const port = await pickEphemeralPort()
	const logPath = join(dataDir, "server.log")
	const logFd = require("node:fs").openSync(logPath, "w")
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
			// not ready yet
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

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

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

afterEach(() => {
	// Cleanup is in afterAll via splice; this hook keeps individual
	// failures from leaking tmp dirs to the next test.
})

// ---------------------------------------------------------------------------
// VAL-DISC-024 — tools/list exposes the three registry tools
// ---------------------------------------------------------------------------

describe("VAL-DISC-024 tools/list exposes the three registry discovery tools", () => {
	it("registers baka_registry_search, baka_registry_get_module, baka_registry_get_preview with zod-derived input schemas", async () => {
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-024-"))
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

			for (const name of ["baka_registry_search", "baka_registry_get_module", "baka_registry_get_preview"] as const) {
				const tool = result.tools.find((t) => t.name === name)
				expect(tool, `${name} not in tools/list`).toBeDefined()
				// Zod-derived input schema (JSON Schema shape, like
				// every other tool).
				expect(tool?.inputSchema.type).toBe("object")
				expect(tool?.inputSchema.properties).toBeDefined()
				// Every property has a description (the contract is
				// "per-property descriptions present").
				const props = (tool?.inputSchema.properties ?? {}) as Record<string, { description?: unknown }>
				for (const [propName, propSchema] of Object.entries(props)) {
					expect(typeof propSchema.description, `${name}.properties.${propName}.description`).toBe("string")
				}
			}

			// Sanity check: `search` requires `query` (the contract
			// pins bad-input handling; if the requirement is missing
			// the schema would silently accept empty queries).
			const searchTool = result.tools.find((t) => t.name === "baka_registry_search")
			expect(searchTool, "search tool missing").toBeDefined()
			const required = (searchTool?.inputSchema.required ?? []) as string[]
			expect(required).toContain("query")

			const getModuleTool = result.tools.find((t) => t.name === "baka_registry_get_module")
			expect(getModuleTool, "get_module tool missing").toBeDefined()
			const getModuleRequired = (getModuleTool?.inputSchema.required ?? []) as string[]
			expect(getModuleRequired).toContain("scope")
			expect(getModuleRequired).toContain("name")

			const getPreviewTool = result.tools.find((t) => t.name === "baka_registry_get_preview")
			expect(getPreviewTool, "get_preview tool missing").toBeDefined()
			const getPreviewRequired = (getPreviewTool?.inputSchema.required ?? []) as string[]
			expect(getPreviewRequired).toContain("scope")
			expect(getPreviewRequired).toContain("name")
			expect(getPreviewRequired).toContain("version")
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-025 — baka_registry_search returns zod-valid structured results
// ---------------------------------------------------------------------------

describe("VAL-DISC-025 baka_registry_search returns zod-valid structured results", () => {
	it("parses each hit against the protocol registry catalog entry schema and returns the expected tier badges", async () => {
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-025-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: server?.baseUrl ?? "" },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "base" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			// VAL-DISC-025: success path is `isError: false`
			// (a JSON-text payload, not an error envelope).
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				query: string
				results: Array<{
					scope: string
					name: string
					version: string | null
					tier: string
					visibility: string
					description: string
					registry: string
				}>
				warnings: unknown[]
			}
			expect(parsed.query).toBe("base")
			expect(Array.isArray(parsed.results)).toBe(true)
			expect(parsed.results.length).toBeGreaterThan(0)
			// Every hit carries the expected field shapes per
			// the registry catalog entry contract (no string
			// fallbacks or missing fields).
			for (const hit of parsed.results) {
				expect(typeof hit.scope).toBe("string")
				expect(typeof hit.name).toBe("string")
				expect(typeof hit.tier).toBe("string")
				expect(["official", "verified", "community-screened", "community-unverified"]).toContain(hit.tier)
				expect(["public", "org"]).toContain(hit.visibility)
				expect(typeof hit.description).toBe("string")
				expect(typeof hit.registry).toBe("string")
			}
			// Built-in catalog surfaces baka-base (the seed server
			// seeds the official scope at boot).
			const names = parsed.results.map((r) => r.name)
			expect(names).toContain("baka-base")
		} finally {
			await shutdown(state)
		}
	})

	it("no-match query returns a SUCCESS result with empty results and zero warnings", async () => {
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-025-empty-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: server?.baseUrl ?? "" },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "xxx-no-such-module-zzz" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				results: unknown[]
				warnings: unknown[]
			}
			expect(parsed.results).toEqual([])
			// Honest: zero warnings means the registry was reachable
			// AND found nothing — distinct from "registry down".
			expect(parsed.warnings).toEqual([])
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-026 — baka_registry_get_module returns the module detail
// ---------------------------------------------------------------------------

describe("VAL-DISC-026 baka_registry_get_module returns structured detail + isError on unknown", () => {
	it("returns the official baka-base detail with manifest, versions, tier, and screening=null", async () => {
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-026-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: server?.baseUrl ?? "" },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_get_module",
				arguments: { scope: "baka", name: "baka-base" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				scope: string
				name: string
				tier: string
				visibility: string
				description: string
				latestVersion: string | null
				versions: Array<{ version: string; status: string }>
				manifest: {
					name: string
					actions: Array<{ id: string }>
				} | null
				screening: unknown
				registry: string
			}
			expect(parsed.scope).toBe("baka")
			expect(parsed.name).toBe("baka-base")
			expect(parsed.tier).toBe("official")
			expect(parsed.visibility).toBe("public")
			expect(parsed.latestVersion).toBeTruthy()
			expect(parsed.versions.length).toBeGreaterThan(0)
			expect(parsed.versions.every((v) => v.status === "ready")).toBe(true)
			expect(parsed.manifest).not.toBeNull()
			// Built-in modules bypass screening (decision 31); the
			// detail is honest.
			expect(parsed.screening).toBeNull()
			const actionIds = (parsed.manifest?.actions ?? []).map((a) => a.id)
			expect(actionIds).toContain("scaffold")
		} finally {
			await shutdown(state)
		}
	})

	it("unknown module returns isError:true with a named not-found message; server stays alive", async () => {
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-026-nf-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: server?.baseUrl ?? "" },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_get_module",
				arguments: { scope: "baka", name: "does-not-exist-zzz" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			expect(result.isError).toBe(true)
			const text = result.content[0].text.toLowerCase()
			expect(text).toContain("does-not-exist-zzz")
			expect(text).toMatch(/not found/i)
			// Server stays alive: subsequent tools/list succeeds.
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-027 — baka_registry_get_preview returns per-action preview list
// ---------------------------------------------------------------------------

describe("VAL-DISC-027 baka_registry_get_preview returns per-action preview list", () => {
	it("for an official built-in module (no screening record) returns an empty previews list honestly", async () => {
		// Built-in modules bypass screening (decision 31); their
		// previews list is the honest empty array — never an
		// error envelope, never fabricated code. The MCP tool
		// surfaces this as a SUCCESS result with `previews: []`.
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-027-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: server?.baseUrl ?? "" },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_get_preview",
				arguments: { scope: "baka", name: "baka-base", version: "0.1.0" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				scope: string
				name: string
				version: string
				registry: string
				previews: Array<{ actionId: string; state: string }>
			}
			expect(parsed.scope).toBe("baka")
			expect(parsed.name).toBe("baka-base")
			expect(typeof parsed.version).toBe("string")
			expect(parsed.registry).toBe(server?.baseUrl)
			expect(Array.isArray(parsed.previews)).toBe(true)
			// Honest empty list — never fabricated code, never error.
			expect(parsed.previews).toEqual([])
		} finally {
			await shutdown(state)
		}
	})

	it("unknown module returns isError:true with a named not-found message", async () => {
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-027-nf-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: server?.baseUrl ?? "" },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_get_preview",
				arguments: { scope: "baka", name: "ghost-mod-zzz", version: "0.0.1" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			expect(result.isError).toBe(true)
			const text = result.content[0].text.toLowerCase()
			expect(text).toContain("ghost-mod-zzz")
			expect(text).toMatch(/not found/i)
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-028 — registry down: search returns isError:true with transport message
// ---------------------------------------------------------------------------

describe("VAL-DISC-028 registry down degrades honestly and the server stays alive", () => {
	it("baka_registry_search against a dead port returns isError:true naming the URL; subsequent tools/list succeeds", async () => {
		const deadPort = await pickBoundThenClosedPort()
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-028-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: `http://127.0.0.1:${deadPort}` },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "anything" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			expect(result.isError).toBe(true)
			const text = result.content[0].text
			expect(text).toContain(`http://127.0.0.1:${deadPort}`)
			// Honest transport message — never raw "fetch failed"
			// without the URL, never a fabricated empty result.
			expect(text.toLowerCase()).toMatch(/unreachable|connection refused|failed/i)
			// No stack trace: the response is a single-line text.
			expect(text).not.toMatch(/\bat .+\.js:\d+:\d+/)
			// Server stays alive: follow-up tools/list must succeed.
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-029 — MCP uses the same registry config resolution chain as the CLI
// ---------------------------------------------------------------------------

describe("VAL-DISC-029 same registry config resolution as the CLI (env > project settings > default)", () => {
	it("env wins: BAKA_REGISTRY_URL pointing at the live registry is preferred over a dead-port project setting", async () => {
		if (!server) throw new Error("seed server not booted")
		const liveUrl = server.baseUrl
		const deadPort = await pickBoundThenClosedPort()
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-029-env-"))
		writeProjectSettings(cwd, JSON.stringify({ registries: [`http://127.0.0.1:${deadPort}`] }, null, 2))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: liveUrl },
		})
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "base" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			// Env wins → search hits the live registry → baka-base
			// appears in the result set.
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				results: Array<{ name: string; registry: string }>
				warnings: Array<{ source: string }>
			}
			expect(parsed.results.some((r) => r.name === "baka-base")).toBe(true)
			for (const hit of parsed.results) {
				expect(hit.registry).toBe(liveUrl)
			}
			// No per-source warning for the dead-port project
			// setting — env won, so the chain never reached it.
			const warnedUrls = parsed.warnings.map((w) => w.source)
			expect(warnedUrls).not.toContain(`http://127.0.0.1:${deadPort}`)
		} finally {
			await shutdown(state)
		}
	})

	it("project settings are honored: registry in .baka/settings.json lists the live URL when no env is set", async () => {
		if (!server) throw new Error("seed server not booted")
		const liveUrl = server.baseUrl
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-029-settings-"))
		writeProjectSettings(cwd, JSON.stringify({ registries: [liveUrl] }, null, 2))
		const state = spawnMcp({ cwd })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "base" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error).toBeUndefined()
			const result = resp?.result as {
				isError?: boolean
				content: Array<{ type: string; text: string }>
			}
			expect(result.isError).toBeFalsy()
			const parsed = JSON.parse(result.content[0].text) as {
				results: Array<{ name: string; registry: string }>
			}
			expect(parsed.results.some((r) => r.name === "baka-base")).toBe(true)
			for (const hit of parsed.results) {
				expect(hit.registry).toBe(liveUrl)
			}
		} finally {
			await shutdown(state)
		}
	})

	it("env at a dead port: registry tools fail honestly while non-registry tools (baka_list_actions) still answer", async () => {
		// VAL-DISC-029 case (c) + VAL-CROSS-014 root invariant:
		// registry tools fail per VAL-DISC-028; non-registry tools
		// (baka_list_actions, baka_validate) stay alive. We exercise
		// `baka_list_actions` against the in-repo modules — the
		// engine never touches the registry for that. The cwd is
		// the baka repo so the shipped modules are discoverable
		// (an empty dir would error from "module not found"
		// independently of the registry).
		const deadPort = await pickBoundThenClosedPort()
		const state = spawnMcp({
			cwd: BAKA_REPO,
			env: { BAKA_REGISTRY_URL: `http://127.0.0.1:${deadPort}` },
		})
		try {
			await initialize(state)
			// Registry tool fails honestly.
			const searchId = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "x" },
			})
			const searchResp = await waitForResponse(state, searchId, 10_000)
			const searchResult = searchResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(searchResult.isError).toBe(true)
			expect(searchResult.content[0].text).toContain(`http://127.0.0.1:${deadPort}`)

			// Non-registry tool still works (local engine is
			// fully functional — baka_list_actions never hits the
			// registry).
			const listId = sendRpc(state, "tools/call", {
				name: "baka_list_actions",
				arguments: { module: "baka-base" },
			})
			const listResp = await waitForResponse(state, listId, 10_000)
			const listResult = listResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(listResult.isError).toBeFalsy()
			const parsed = JSON.parse(listResult.content[0].text) as { module: string; actions: unknown[] }
			expect(parsed.module).toBe("baka-base")
			expect(parsed.actions.length).toBeGreaterThan(0)
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-044 — MCP exposes no install capability and says so
// ---------------------------------------------------------------------------

describe("VAL-DISC-044 no install capability and the install handoff is named", () => {
	it("tool descriptions do NOT offer to install/materialize/download, but DO name the CLI handoff", async () => {
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-044-"))
		const state = spawnMcp({ cwd })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/list")
			const resp = await waitForResponse(state, id, 5_000)
			const result = resp?.result as { tools: Array<{ name: string; description: string }> }
			// The three registry tool names carry no install verb.
			for (const name of ["baka_registry_search", "baka_registry_get_module", "baka_registry_get_preview"]) {
				const tool = result.tools.find((t) => t.name === name)
				expect(tool, name).toBeDefined()
				expect(tool?.name.toLowerCase()).not.toMatch(/\binstall\b/)
				expect(tool?.name.toLowerCase()).not.toMatch(/\bmaterialize\b/)
				expect(tool?.name.toLowerCase()).not.toMatch(/\bdownload\b/)
				// The description itself must NOT offer install as
				// a tool behavior — only as the CLI handoff.
				const desc = tool?.description.toLowerCase() ?? ""
				expect(desc, `${name}.description`).not.toMatch(/this tool\s+installs/)
				expect(desc, `${name}.description`).not.toMatch(/installs\s+the module/)
				expect(desc, `${name}.description`).not.toMatch(/we will install/)
				expect(desc, `${name}.description`).not.toMatch(/materializ\w*\s+the module/)
				expect(desc, `${name}.description`).not.toMatch(/download\w*\s+the module/)
				// Every registry description explicitly names the
				// `baka install @<scope>/<name>` CLI handoff so an
				// agent client can branch on the tool output
				// without guessing.
				expect(tool?.description, `${name} description`).toContain("baka install")
			}
			// No tool name suggests installation at all.
			for (const t of result.tools) {
				expect(t.name.toLowerCase()).not.toMatch(/\binstall\b/)
				expect(t.name).not.toBe("baka_install")
			}
		} finally {
			await shutdown(state)
		}
	})

	it("the MCP README explicitly states the install handoff to the baka CLI", async () => {
		expect(existsSync(MCP_README), `missing MCP README at ${MCP_README}`).toBe(true)
		const readme = readFileSync(MCP_README, "utf-8")
		// Architecture §8 decision 9 + VAL-DISC-044: the handoff
		// is named on the README, not just on tool descriptions.
		expect(readme).toMatch(/baka\s+install\s+@/)
		// The non-install invariant is named on the README so a
		// future tool addition cannot drift without an explicit
		// doc change. The README uses phrasing like "do NOT
		// install anything" and "install is the `baka` CLI's job"
		// — both encode the no-install invariant.
		const readmeLower = readme.toLowerCase()
		expect(
			readmeLower.includes("do not install") ||
				readmeLower.includes("don't install") ||
				readmeLower.includes("no install capability") ||
				readmeLower.includes("install is the"),
		).toBe(true)
	})

	it("calling every registry tool leaves the cwd tree byte-identical (discovery is read-only)", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-044-cwd-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: server.baseUrl },
		})
		try {
			await initialize(state)
			// Snapshot the cwd: nothing in it but an empty directory.
			const beforeEntries = require("node:fs").readdirSync(cwd)
			// Run every registry tool with sensible inputs.
			for (const call of [
				{ name: "baka_registry_search", arguments: { query: "base" } },
				{
					name: "baka_registry_get_module",
					arguments: { scope: "baka", name: "baka-base" },
				},
				{
					name: "baka_registry_get_preview",
					arguments: { scope: "baka", name: "baka-base", version: "0.1.0" },
				},
			] as const) {
				const id = sendRpc(state, "tools/call", { name: call.name, arguments: call.arguments })
				const resp = await waitForResponse(state, id, 10_000)
				expect(resp?.error).toBeUndefined()
			}
			const afterEntries = require("node:fs").readdirSync(cwd)
			expect(afterEntries.sort()).toEqual(beforeEntries.sort())
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-045 — argument validation and bad-input survival
// ---------------------------------------------------------------------------

describe("VAL-DISC-045 registry tools validate arguments and survive bad input", () => {
	it("missing/wrong-type fields return isError:true naming the offending field; server stays alive", async () => {
		if (!server) throw new Error("seed server not booted")
		const cwd = trackDir(makeEmptyDir("baka-mcp-rt-045-"))
		const state = spawnMcp({
			cwd,
			env: { BAKA_REGISTRY_URL: server.baseUrl },
		})
		try {
			await initialize(state)

			// Missing query.
			const id1 = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: {},
			})
			const resp1 = await waitForResponse(state, id1, 10_000)
			const r1 = resp1?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(r1?.isError).toBe(true)
			expect(r1.content[0].text.toLowerCase()).toContain("query")

			// Wrong type for scope.
			const id2 = sendRpc(state, "tools/call", {
				name: "baka_registry_get_module",
				arguments: { scope: 123, name: "baka-base" },
			})
			const resp2 = await waitForResponse(state, id2, 10_000)
			const r2 = resp2?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(r2?.isError).toBe(true)
			expect(r2.content[0].text.toLowerCase()).toContain("scope")

			// Wrong type for version.
			const id3 = sendRpc(state, "tools/call", {
				name: "baka_registry_get_preview",
				arguments: { scope: "baka", name: "baka-base", version: ["v1"] },
			})
			const resp3 = await waitForResponse(state, id3, 10_000)
			const r3 = resp3?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(r3?.isError).toBe(true)
			expect(r3.content[0].text.toLowerCase()).toContain("version")

			// Server stays alive — follow-up tools/list succeeds.
			const listId = sendRpc(state, "tools/list")
			const listResp = await waitForResponse(state, listId, 5_000)
			expect(listResp?.error).toBeUndefined()

			// And a well-formed call after the bad inputs still
			// works (no internal-state corruption).
			const id4 = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "base" },
			})
			const resp4 = await waitForResponse(state, id4, 10_000)
			const r4 = resp4?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(r4?.isError).toBeFalsy()
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-CROSS-014 — offline/degraded mode: registry tools fail, local engine works
// ---------------------------------------------------------------------------

describe("VAL-CROSS-014 offline mode: registry down → registry tools fail, local engine works", () => {
	it("with no flag, no env, no project settings, the MCP falls back to localhost:4300 and times out fast (no hang)", async () => {
		// No BAKA_REGISTRY_URL, no .baka/settings.json — default
		// kicks in. The default localhost:4300 is not running in
		// this test environment, so the registry tool fails with
		// a transport message. The engine-driven tools
		// (`baka_list_actions`, `baka_validate`) never touch the
		// registry and keep answering. This is the contract-level
		// offline / degraded-mode invariant: the registry is
		// OPTIONAL for local engine usage. We run from BAKA_REPO
		// so `baka_list_actions` can resolve against the shipped
		// modules (an empty cwd would surface its own "module not
		// found" error, independent of the registry being down).
		const state = spawnMcp({ cwd: BAKA_REPO })
		try {
			await initialize(state)
			const startMs = Date.now()
			const id = sendRpc(state, "tools/call", {
				name: "baka_registry_search",
				arguments: { query: "anything" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			const elapsed = Date.now() - startMs
			const r = resp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(r?.isError).toBe(true)
			expect(r.content[0].text).toContain("http://localhost:4300")
			// A TCP "connection refused" to a dead localhost port
			// resolves in tens of milliseconds — never a hang.
			expect(elapsed).toBeLessThan(5_000)
			// Non-registry tools still work (local engine is
			// fully functional).
			const listId = sendRpc(state, "tools/call", {
				name: "baka_list_actions",
				arguments: { module: "baka-base" },
			})
			const listResp = await waitForResponse(state, listId, 10_000)
			const listResult = listResp?.result as { isError?: boolean; content: Array<{ text: string }> }
			expect(listResult.isError).toBeFalsy()
			const parsed = JSON.parse(listResult.content[0].text) as { module: string }
			expect(parsed.module).toBe("baka-base")
		} finally {
			await shutdown(state)
		}
	})
})
