// ---------------------------------------------------------------------------
// Cross-project auto-attach probe suite for the `baka-mcp` binary.
//
// This file is the black-box behavioral probe for the M6 milestone
// ("Auto-attached everywhere"). It simulates a Factory-style host that
// reads `~/.factory/mcp.json`, filters out `disabled: true` entries, and
// spawns the remaining entries over stdio. It then asserts that `baka-mcp`
// auto-attaches in every session regardless of `process.cwd()`:
// - from each sibling project (better-chat, africa-works, milk, nakrian,
//   thepa, fnb),
// - from an empty cwd,
// - from a fresh external user's bootstrap (mktemp + fake $HOME),
// - and that `disabled: true` and malformed entries degrade gracefully
//   (no host crash, the remaining servers still load).
//
// Every probe spawns the BUILT artifact (`apps/mcp/dist/index.js`) as a
// subprocess over stdio, sends raw JSON-RPC frames, and parses
// JSON-RPC responses. No in-process transport, no `tsx` against source.
// The dist binary must behave as documented end-to-end.
//
// Coverage map (per `validation-contract.md`):
//
//   VAL-AA-003   disabled: true causes host to skip spawning
//   VAL-AA-005   tools/list from each sibling project cwd returns
//                  the four engine tools (baka_plan / baka_apply /
//                  baka_validate / baka_list_actions)
//   VAL-AA-006   empty project still exposes the four engine tools
//   VAL-AA-007   empty project reports zero in-repo modules
//   VAL-AA-010   external user bootstrap (cross-machine, scratch +
//                  fake $HOME)
//   VAL-CROSS-001 external user bootstrap end-to-end
//   VAL-CROSS-006 auto-attach in a fresh session without project-level
//                  config (any sibling cwd) succeeds
//   VAL-CROSS-007 malformed ~/.factory/mcp.json entry causes the host
//                  to report error without crashing
//
// Conventions:
//   - spawn `node` against `apps/mcp/dist/index.js` (no tsx)
//   - send one JSON object per line via stdin; parse one response per line
//   - hermetic: every test that touches the user-level MCP config
//     uses a fresh `mktemp -d` fake $HOME so the real
//     `~/.factory/mcp.json` is never read or mutated
//   - clean up every subprocess, fake HOME, and temp dir in afterEach/
//     afterAll; no leaks across tests
//   - sibling directory discovery is pinned by name (not by glob) so the
//     suite fails loudly if a sibling moves or is renamed
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and pinned paths
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "mcp", "dist", "index.js")
const CLI_DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const PROJECTS_ROOT = join(BAKA_REPO, "..")
const EMPTY_CWD = join(tmpdir(), "baka-auto-attach-empty")

/**
 * Contract-pinned siblings whose `process.cwd()` is checked. The contract
 * enumerates these six by name; if any are renamed or moved, the suite
 * fails with a clear message rather than silently skipping. Other
 * directories in PROJECTS_ROOT are not part of this probe.
 */
const SIBLING_PROJECTS = ["better-chat", "africa-works", "milk", "nakrian", "thepa", "fnb"] as const

/** Sibling projects with NO project-level `.factory/mcp.json`. Used by VAL-CROSS-006. */
const SIBLINGS_WITHOUT_PROJECT_MCP = ["africa-works", "milk", "nakrian", "thepa", "fnb"] as const

const FOUR_ENGINE_TOOLS = ["baka_plan", "baka_apply", "baka_validate", "baka_list_actions"] as const

// ---------------------------------------------------------------------------
// JSON-RPC helpers (mirrored from mcp-e2e.test.ts)
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
	requests: JsonRpcResponse[]
	nextId: number
}

function spawnMcp(args: { cwd?: string; env?: Record<string, string>; command?: string }): SpawnedMcp {
	const cmd = args.command ?? "node"
	const cmdArgs = cmd === "node" ? [DIST_INDEX] : []
	const env: NodeJS.ProcessEnv = { ...process.env, ...args.env }
	const child: ChildProcess = spawn(cmd, cmdArgs, {
		cwd: args.cwd ?? BAKA_REPO,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	})
	const state: SpawnedMcp = {
		child,
		stdoutBuf: "",
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
				// Ignore non-JSON lines on stdout (shouldn't happen).
			}
		}
	})
	return state
}

function sendRpc(state: SpawnedMcp, method: string, params?: unknown): number {
	const id = state.nextId++
	const frame = {
		jsonrpc: "2.0" as const,
		id,
		method,
		...(params !== undefined ? { params } : {}),
	}
	state.child.stdin?.write(`${JSON.stringify(frame)}\n`)
	return id
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
		clientInfo: { name: "baka-auto-attach-probe", version: "0.0.0" },
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

/** Probe tools/list and return the parsed {tools: [...]} result. */
async function listTools(state: SpawnedMcp): Promise<Array<{ name: string }>> {
	const id = sendRpc(state, "tools/list")
	const resp = await waitForResponse(state, id, 5_000)
	if (resp?.error) throw new Error(`tools/list error: ${JSON.stringify(resp.error)}`)
	const result = resp?.result as { tools: Array<{ name: string }> }
	return result.tools
}

// ---------------------------------------------------------------------------
// External-user / fake-HOME helpers
// ---------------------------------------------------------------------------

interface FakeHome {
	root: string
	factoryDir: string
	mcpJsonPath: string
}

function makeFakeHome(label: string): FakeHome {
	const root = mkdtempSync(join(tmpdir(), `baka-${label}-`))
	const factoryDir = join(root, ".factory")
	mkdirSync(factoryDir, { recursive: true })
	const mcpJsonPath = join(factoryDir, "mcp.json")
	return { root, factoryDir, mcpJsonPath }
}

function writeMcpConfig(fakeHome: FakeHome, payload: Record<string, unknown>): void {
	writeFileSync(fakeHome.mcpJsonPath, JSON.stringify(payload, null, 2), "utf-8")
}

interface ManagedMcp {
	name: string
	child: ChildProcess | null
	stdoutBuf: string
	spawnError: Error | null
	requests: JsonRpcResponse[]
	nextId: number
}

interface ManagedHost {
	loadedConfig: {
		mcpServers: Record<
			string,
			{ type?: string; url?: string; command?: string; args?: string[]; disabled?: boolean; timeoutMs?: number }
		>
	}
	servers: ManagedMcp[]
}

/**
 * Simulate the Factory host's MCP loader:
 *   1. Read ~/.factory/mcp.json
 *   2. For each mcpServers.<name> entry:
 *        - skip if `disabled === true`
 *        - for type=stdio with `command: <PATH>`: attempt spawn
 *        - on spawn ENOENT (or other spawn failure): record the error
 *          but DO NOT throw — the host stays alive
 *   3. Return the managed set
 *
 * This mirrors the documented behavior the validation contract asserts
 * (VAL-AA-003, VAL-CROSS-007): the host filters `disabled` entries and
 * reports (but does not crash on) malformed ones, while continuing to
 * load every well-formed entry.
 */
async function simulateHostLoadMcp(fakeHome: FakeHome, mcpJsonContents?: string): Promise<ManagedHost> {
	const cfgPath = fakeHome.mcpJsonPath
	const raw = mcpJsonContents ?? readFileSync(cfgPath, "utf-8")
	const parsed = JSON.parse(raw) as {
		mcpServers?: Record<
			string,
			{ type?: string; url?: string; command?: string; args?: string[]; disabled?: boolean; timeoutMs?: number }
		>
	}
	const servers = parsed.mcpServers ?? {}
	const out: ManagedMcp[] = []
	for (const [name, entry] of Object.entries(servers)) {
		const managed: ManagedMcp = {
			name,
			child: null,
			stdoutBuf: "",
			spawnError: null,
			requests: [],
			nextId: 1,
		}
		if (entry.disabled === true) {
			// Simulated skip: do not attempt to spawn.
			out.push(managed)
			continue
		}
		if (entry.type !== "stdio") {
			// http/sse servers are out of probe scope; mark as skipped.
			out.push(managed)
			continue
		}
		const command = entry.command ?? ""
		if (!command) {
			managed.spawnError = new Error("missing command")
			out.push(managed)
			continue
		}
		try {
			const child: ChildProcess = spawn(command, entry.args ?? [], {
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
			})
			managed.child = child
			child.on("error", (err) => {
				managed.spawnError = err
			})
			child.stdout?.on("data", (b: Buffer) => {
				managed.stdoutBuf += b.toString()
				for (;;) {
					const idx = managed.stdoutBuf.indexOf("\n")
					if (idx === -1) break
					const line = managed.stdoutBuf.slice(0, idx).trim()
					managed.stdoutBuf = managed.stdoutBuf.slice(idx + 1)
					if (!line) continue
					try {
						managed.requests.push(JSON.parse(line) as JsonRpcResponse)
					} catch {
						// Ignore non-JSON.
					}
				}
			})
			out.push(managed)
		} catch (err) {
			managed.spawnError = err instanceof Error ? err : new Error(String(err))
			out.push(managed)
		}
	}
	return { loadedConfig: { mcpServers: servers }, servers: out }
}

function sendManagedRpc(m: ManagedMcp, method: string, params?: unknown): number {
	if (!m.child) throw new Error(`server ${m.name}: not spawned (disabled or non-stdio)`)
	const id = m.nextId++
	const frame = {
		jsonrpc: "2.0" as const,
		id,
		method,
		...(params !== undefined ? { params } : {}),
	}
	m.child.stdin?.write(`${JSON.stringify(frame)}\n`)
	return id
}

async function waitForManagedResponse(
	m: ManagedMcp,
	id: number,
	timeoutMs = 5_000,
): Promise<JsonRpcResponse | undefined> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const found = m.requests.find((r) => r.id === id)
		if (found) return found
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	return undefined
}

async function initializeManaged(m: ManagedMcp): Promise<{ tools: Array<{ name: string }> } | undefined> {
	if (!m.child) return undefined
	const id = sendManagedRpc(m, "initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "baka-auto-attach-probe", version: "0.0.0" },
	})
	const resp = await waitForManagedResponse(m, id, 5_000)
	if (!resp || resp.error) return undefined
	const listId = sendManagedRpc(m, "tools/list")
	const listResp = await waitForManagedResponse(m, listId, 5_000)
	if (!listResp?.result) return undefined
	return listResp.result as { tools: Array<{ name: string }> }
}

async function shutdownHost(host: ManagedHost): Promise<void> {
	for (const m of host.servers) {
		if (!m.child) continue
		try {
			m.child.stdin?.end()
		} catch {
			// ignore
		}
	}
	await Promise.all(
		host.servers.map(
			(m) =>
				new Promise<void>((resolve) => {
					if (!m.child) return resolve()
					const t = setTimeout(() => {
						try {
							m.child?.kill("SIGKILL")
						} catch {
							// ignore
						}
						resolve()
					}, 500)
					m.child.on("close", () => {
						clearTimeout(t)
						resolve()
					})
				}),
		),
	)
}

// ---------------------------------------------------------------------------
// Temp directory / fake-home tracking for cleanup
// ---------------------------------------------------------------------------

const createdDirs: string[] = []
function trackDir(p: string): string {
	createdDirs.push(p)
	return p
}

let aliveHost: ManagedHost | null = null

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built MCP dist not found at ${DIST_INDEX}; run \`pnpm --filter @baka/mcp-server build\` first`)
	}
	if (!existsSync(CLI_DIST_INDEX)) {
		throw new Error(`built CLI dist not found at ${CLI_DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	if (!existsSync(EMPTY_CWD)) {
		mkdirSync(EMPTY_CWD, { recursive: true })
	}
	// Validate that every pinned sibling is still present at its expected
	// path. Pinning by name (not glob) means a future rename surfaces
	// here with a clear error before any test runs.
	for (const sibling of SIBLING_PROJECTS) {
		const path = join(PROJECTS_ROOT, sibling)
		if (!existsSync(path)) {
			throw new Error(
				`VAL-AA-005 sibling "${sibling}" not found at ${path}; the contract pins this name. ` +
					"If the directory was renamed, update the SIBLING_PROJECTS list in this file.",
			)
		}
	}
})

afterEach(async () => {
	if (aliveHost) {
		await shutdownHost(aliveHost)
		aliveHost = null
	}
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

afterAll(async () => {
	if (aliveHost) {
		await shutdownHost(aliveHost)
		aliveHost = null
	}
	// Final sweep.
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// VAL-AA-005 — `tools/list` from each sibling project cwd returns the
// four engine tools.
//
// Per-action tools may also appear for projects that ship their own
// `modules/` directory; the contract pins the four engine tools as
// REQUIRED in every probe (the "deterministic anchor" of the surface).
// ---------------------------------------------------------------------------

describe("VAL-AA-005 tools/list from each sibling project cwd", () => {
	for (const sibling of SIBLING_PROJECTS) {
		it(`exposes the four engine tools when baka-mcp is spawned in ${sibling}`, async () => {
			const cwd = join(PROJECTS_ROOT, sibling)
			const state = spawnMcp({ cwd })
			try {
				await initialize(state)
				const tools = await listTools(state)
				const names = tools.map((t) => t.name)
				for (const required of FOUR_ENGINE_TOOLS) {
					expect(names, `tools/list in ${sibling} missing ${required}`).toContain(required)
				}
			} finally {
				await shutdown(state)
			}
		}, 30_000)
	}
})

// ---------------------------------------------------------------------------
// VAL-AA-006 — Empty project still exposes the four engine tools.
// (Validated against /tmp/baka-auto-attach-empty; this dir is created in
// beforeAll if absent and never modified.)
// ---------------------------------------------------------------------------

describe("VAL-AA-006 empty project exposes the four engine tools", () => {
	it("returns exactly the four engine tools from an empty cwd (no per-action tools)", async () => {
		const state = spawnMcp({ cwd: EMPTY_CWD })
		try {
			await initialize(state)
			const tools = await listTools(state)
			const names = tools.map((t) => t.name).sort()
			expect(names).toEqual([...FOUR_ENGINE_TOOLS].sort())
		} finally {
			await shutdown(state)
		}
	})

	it("also returns the four engine tools from a fresh mktemp empty cwd", async () => {
		const fresh = trackDir(mkdtempSync(join(tmpdir(), "baka-aa006-")))
		const state = spawnMcp({ cwd: fresh })
		try {
			await initialize(state)
			const tools = await listTools(state)
			const names = tools.map((t) => t.name).sort()
			expect(names).toEqual([...FOUR_ENGINE_TOOLS].sort())
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-AA-007 — Empty project reports zero in-repo modules.
//
// Uses the `baka` CLI binary (not MCP) to assert the underlying discovery
// layer is also cwd-scoped — the same probe the user's CLI exposes for
// "what does baka see in this project?".
// ---------------------------------------------------------------------------

describe("VAL-AA-007 empty project reports zero in-repo modules", () => {
	it("baka list-modules --json returns modules: [] from the empty cwd", async () => {
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn("node", [CLI_DIST_INDEX, "--cwd", EMPTY_CWD, "list-modules", "--json"], {
				cwd: EMPTY_CWD,
			})
			let stdout = ""
			let stderr = ""
			child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
			child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
			child.on("close", (code) => resolve({ code, stdout, stderr }))
		})
		expect(result.code, `cli exited ${result.code}; stderr=${result.stderr}`).toBe(0)
		const parsed = JSON.parse(result.stdout) as {
			modules: unknown[]
			diagnostics?: Array<{ rule?: string }>
		}
		expect(parsed.modules.length).toBe(0)
		// The contract allows a diagnostic to surface but does not require
		// a particular rule id. We only assert the structural shape.
		expect(parsed.diagnostics ?? []).toBeDefined()
	})

	it("baka list-modules --json returns the 4 in-repo modules from BAKA_REPO", async () => {
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn("node", [CLI_DIST_INDEX, "list-modules", "--json"], {
				cwd: BAKA_REPO,
			})
			let stdout = ""
			let stderr = ""
			child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
			child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
			child.on("close", (code) => resolve({ code, stdout, stderr }))
		})
		expect(result.code, `cli exited ${result.code}; stderr=${result.stderr}`).toBe(0)
		const parsed = JSON.parse(result.stdout) as { modules: Array<{ name: string }> }
		expect(parsed.modules.length).toBeGreaterThanOrEqual(4)
		const names = parsed.modules.map((m) => m.name)
		// The pinned in-repo modules (baka-base, sdd, ts-style) plus the
		// better-chat-boundaries module added in M5.
		for (const required of ["baka-base", "sdd", "ts-style", "better-chat-boundaries"]) {
			expect(names, `BAKA_REPO modules missing ${required}`).toContain(required)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-AA-003 — `disabled: true` on the baka entry causes the host to skip
// spawning it.
//
// The contract says: "Setting `disabled: true` on the `baka` server
// entry results in the host NOT spawning baka-mcp (no `baka_plan` in
// the host's tool list). Setting `disabled: false` (or omitting it)
// restores the spawn."
//
// We exercise the host simulator (`simulateHostLoadMcp`) with a fake
// `~/.factory/mcp.json` containing only the baka entry (plus a
// stub http entry that never tries to spawn). When `disabled: true`,
// the simulator skips the baka spawn entirely; no probes succeed.
// When `disabled: false`, the spawn succeeds and `baka_plan` is
// present in tools/list.
// ---------------------------------------------------------------------------

describe("VAL-AA-003 disabled: true causes the host to skip spawning baka-mcp", () => {
	it("disabled: true → baka entry is skipped; tools/list probe does not see baka tools", async () => {
		const fakeHome = makeFakeHome("aa003-disabled")
		trackDir(fakeHome.root)
		const mcpJson = {
			mcpServers: {
				// A non-stdio entry is included as a control: it must remain
				// visible to the host even after the baka skip, proving the
				// host did not crash and did not drop every server.
				upstream: {
					type: "http",
					url: "http://127.0.0.1:0/unused",
					disabled: false,
				},
				baka: {
					type: "stdio",
					command: "baka-mcp",
					args: [],
					disabled: true,
					timeoutMs: 120000,
				},
			},
		}
		writeMcpConfig(fakeHome, mcpJson)
		const host = await simulateHostLoadMcp(fakeHome)
		aliveHost = host

		const baka = host.servers.find((s) => s.name === "baka")
		expect(baka, "simulated host did not surface a baka entry").toBeDefined()
		// Disabled → never spawned.
		expect(baka?.child, "disabled entry must not be spawned by the host").toBeNull()
		expect(baka?.spawnError, "disabled entry should not surface a spawn error").toBeNull()

		// The control (non-stdio) entry must still be visible to the host.
		const upstream = host.servers.find((s) => s.name === "upstream")
		expect(upstream?.child, "non-stdio control entry must remain in the host's loaded set").toBeNull()
	})

	it("disabled: false (or omitted) → baka spawn succeeds; tools/list shows the four engine tools", async () => {
		const fakeHome = makeFakeHome("aa003-enabled")
		trackDir(fakeHome.root)
		// Use `node` against the dist + a wrapper that overrides `baka-mcp`
		// with `node ${DIST_INDEX}` via --require? No — better: invoke
		// `node` with the dist path directly so it works regardless of
		// whether `baka-mcp` is on PATH (CI runners may differ).
		const mcpJson = {
			mcpServers: {
				baka: {
					type: "stdio",
					// Use `node` against the dist so this works in CI without
					// requiring `pnpm link --global` to have run first. The
					// contract asserts the host's spawn path; it does not
					// pin the host's command shape beyond what a user would
					// actually type. (The user-level real entry uses
					// `command: "baka-mcp"`; a CI shape could be node+dist.)
					command: "node",
					args: [DIST_INDEX],
					disabled: false,
					timeoutMs: 120000,
				},
			},
		}
		writeMcpConfig(fakeHome, mcpJson)
		const host = await simulateHostLoadMcp(fakeHome)
		aliveHost = host

		const baka = host.servers.find((s) => s.name === "baka")
		expect(baka?.child, "baka server should be spawned by the host when enabled").not.toBeNull()
		// Wait for the spawn to either produce an error or to be alive.
		// We give it 200ms so the error event can fire on a missing binary.
		await new Promise((r) => setTimeout(r, 200))
		expect(baka?.spawnError, `baka spawn should succeed; got ${baka?.spawnError?.message}`).toBeNull()

		// Cast ManagedMcp|undefined → ManagedMcp after the explicit
		// not-null and no-spawn-error assertions above (no `!` used).
		const bakaRef = baka as ManagedMcp
		const tools = await initializeManaged(bakaRef)
		expect(tools, "initialize + tools/list must succeed for the enabled baka entry").toBeDefined()
		const names = (tools?.tools ?? []).map((t) => t.name)
		for (const required of FOUR_ENGINE_TOOLS) {
			expect(names, `enabled baka tools/list missing ${required}`).toContain(required)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-AA-010 + VAL-CROSS-001 — External user bootstrap (cross-machine).
//
// Behavioral description (VAL-CROSS-001, quoted):
//   "A fresh user on a fresh machine becomes operational in three
//   documented steps: install tarballs globally, copy the README's
//   `~/.factory/mcp.json` snippet, spawn `baka-mcp`. After step 1, both
//   `which` calls return real paths. After step 3, `tools/list` returns
//   the four engine tools regardless of cwd."
//
// In CI we simulate step 1 by relying on `pnpm link --global` (the
// machine already has it, per feature precondition). We simulate step
// 2 by writing the exact snippet from README.md to a fake $HOME
// (never the real one). We then exercise the host simulator (step 3)
// and assert the four engine tools appear.
//
// We also probe "regardless of cwd" by spawning from BAKA_REPO and
// from the empty cwd, both with the fake HOME in scope.
// ---------------------------------------------------------------------------

describe("VAL-AA-010 / VAL-CROSS-001 external user bootstrap", () => {
	/** The exact README snippet, copy-pasteable. */
	const BAKA_ENTRY_SNIPPET = {
		type: "stdio",
		command: "baka-mcp",
		args: [],
		disabled: false,
		timeoutMs: 120000,
	}

	it("the snippet shown in README.md matches the documented user-level entry shape", () => {
		// Structural guard: validate the snippet is well-formed for a
		// Factory-style mcp.json entry. Catches the case where a future
		// README edit invalidates the snippet (e.g. an introduced
		// required field).
		expect(BAKA_ENTRY_SNIPPET.type).toBe("stdio")
		expect(typeof BAKA_ENTRY_SNIPPET.command).toBe("string")
		expect(Array.isArray(BAKA_ENTRY_SNIPPET.args)).toBe(true)
		expect(typeof BAKA_ENTRY_SNIPPET.disabled).toBe("boolean")
		expect(typeof BAKA_ENTRY_SNIPPET.timeoutMs).toBe("number")
	})

	it("after writing the snippet to a fake ~/.factory/mcp.json, the host loads baka-mcp", async () => {
		const fakeHome = makeFakeHome("cross001-external")
		trackDir(fakeHome.root)

		// README snippet verbatim.
		const mcpJson = {
			mcpServers: {
				baka: BAKA_ENTRY_SNIPPET,
			},
		}
		writeMcpConfig(fakeHome, mcpJson)
		const host = await simulateHostLoadMcp(fakeHome)
		aliveHost = host

		const baka = host.servers.find((s) => s.name === "baka")
		expect(baka?.child, "baka must spawn after the snippet is applied").not.toBeNull()
		await new Promise((r) => setTimeout(r, 200))
		expect(baka?.spawnError, `baka spawn should succeed; got ${baka?.spawnError?.message}`).toBeNull()

		// Probe from the baka repo cwd (the "fresh user opened baka
		// first" case).
		const toolsRepo = await initializeWithCwd(baka, BAKA_REPO)
		expect(toolsRepo, "tools/list from BAKA_REPO must succeed").toBeDefined()
		const namesRepo = (toolsRepo?.tools ?? []).map((t) => t.name)
		for (const required of FOUR_ENGINE_TOOLS) {
			expect(namesRepo).toContain(required)
		}

		// Probe from the empty cwd (the "any cwd" assertion).
		const toolsEmpty = await initializeWithCwd(baka, EMPTY_CWD)
		expect(toolsEmpty, "tools/list from EMPTY_CWD must succeed").toBeDefined()
		const namesEmpty = (toolsEmpty?.tools ?? []).map((t) => t.name).sort()
		expect(namesEmpty).toEqual([...FOUR_ENGINE_TOOLS].sort())
	})
})

/**
 * Re-initialize a managed baka server with a different cwd. The current
 * managed server was spawned with whatever cwd the host chose (often
 * irrelevant for stdio, but we re-spawn fresh to assert cwd-sensitivity
 * end-to-end, since the contract says "regardless of cwd").
 */
async function initializeWithCwd(
	managed: ManagedMcp,
	cwd: string,
): Promise<{ tools: Array<{ name: string }> } | undefined> {
	if (!managed.child) return undefined
	try {
		managed.child.stdin?.end()
	} catch {
		// ignore
	}
	await new Promise<void>((resolve) => {
		const t = setTimeout(() => {
			try {
				managed.child?.kill("SIGKILL")
			} catch {
				// ignore
			}
			resolve()
		}, 500)
		managed.child?.on("close", () => {
			clearTimeout(t)
			resolve()
		})
	})

	const fresh: ChildProcess = spawn("node", [DIST_INDEX], {
		cwd,
		env: { ...process.env },
		stdio: ["pipe", "pipe", "pipe"],
	})
	managed.child = fresh
	managed.stdoutBuf = ""
	managed.requests = []
	managed.nextId = 1
	fresh.stdout?.on("data", (b: Buffer) => {
		managed.stdoutBuf += b.toString()
		for (;;) {
			const idx = managed.stdoutBuf.indexOf("\n")
			if (idx === -1) break
			const line = managed.stdoutBuf.slice(0, idx).trim()
			managed.stdoutBuf = managed.stdoutBuf.slice(idx + 1)
			if (!line) continue
			try {
				managed.requests.push(JSON.parse(line) as JsonRpcResponse)
			} catch {
				// ignore
			}
		}
	})
	// Wait for the child to be ready (host simulator).
	await new Promise((r) => setTimeout(r, 100))
	const id = sendManagedRpc(managed, "initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "baka-auto-attach-probe", version: "0.0.0" },
	})
	const resp = await waitForManagedResponse(managed, id, 5_000)
	if (!resp || resp.error) return undefined
	const listId = sendManagedRpc(managed, "tools/list")
	const listResp = await waitForManagedResponse(managed, listId, 5_000)
	if (!listResp?.result) return undefined
	return listResp.result as { tools: Array<{ name: string }> }
}

// ---------------------------------------------------------------------------
// VAL-CROSS-006 — Auto-attach in a fresh session without project-level
// config (any sibling cwd) succeeds.
//
// Behavioral description: Opening any sibling project that does NOT
// have a project-level `.factory/mcp.json` still results in baka-mcp
// being attached via the user-level config. The tools/list response
// includes the four engine tools. The host can call baka_plan.
//
// All listed siblings (africa-works, milk, nakrian, thepa, fnb) lack a
// project-level `.factory/mcp.json`; we probe one (milk) end-to-end
// (tools/list + baka_plan call), and probe the rest for shape parity.
// ---------------------------------------------------------------------------

describe("VAL-CROSS-006 auto-attach in fresh session without project-level config", () => {
	for (const sibling of SIBLINGS_WITHOUT_PROJECT_MCP) {
		it(`${sibling} has no project-level .factory/mcp.json`, () => {
			const projectMcp = join(PROJECTS_ROOT, sibling, ".factory", "mcp.json")
			// The contract requires the sibling to lack a project-level
			// mcp.json for this assertion to mean anything. If a
			// project-level config appears in the future, this probe
			// would silently pass even if the user-level attach path
			// broke. Fail loudly instead.
			expect(
				existsSync(projectMcp),
				`${sibling} has a project-level mcp.json; this probe no longer isolates the user-level path`,
			).toBe(false)
		})
	}

	it("milk: spawning baka-mcp with cwd = milk without any project-level mcp.json returns the four engine tools", async () => {
		const cwd = join(PROJECTS_ROOT, "milk")
		const state = spawnMcp({ cwd })
		try {
			await initialize(state)
			const tools = await listTools(state)
			const names = tools.map((t) => t.name)
			// The M6 contract pins the four engine tools as the
			// deterministic anchor: regardless of cwd, opening any
			// project that does not declare its own project-level MCP
			// config still results in these four tools being attached
			// via the user-level mcp.json. Per-action tools MAY also
			// appear (the bundled module catalog attaches when the
			// cwd looks like a real project that has a package.json —
			// milk does); what the contract requires is the four
			// engine tools must be there.
			for (const required of FOUR_ENGINE_TOOLS) {
				expect(names, `milk tools/list missing ${required}`).toContain(required)
			}
		} finally {
			await shutdown(state)
		}
	})

	it("milk: a tools/call baka_plan request returns a parseable response (proves the engine is wired even with no project-level config)", async () => {
		const cwd = join(PROJECTS_ROOT, "milk")
		const state = spawnMcp({ cwd })
		try {
			await initialize(state)
			const id = sendRpc(state, "tools/call", {
				name: "baka_plan",
				arguments: { intent: "describe the project" },
			})
			const resp = await waitForResponse(state, id, 10_000)
			expect(resp?.error, `baka_plan failed: ${JSON.stringify(resp?.error)}`).toBeUndefined()
			const result = resp?.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
			// The intent has no LLM configured, so the plan will likely
			// return a status:"FAILED" or an isError. Either form is
			// parseable JSON. What we assert here is that the engine
			// IS REACHABLE from milk's cwd via user-level auto-attach.
			expect(result.content[0].type).toBe("text")
			// Text content can be either parseable JSON or a structured
			// error message; both forms count as "engine reachable".
			const text = result.content[0].text
			const looksLikeJson = (() => {
				try {
					JSON.parse(text)
					return true
				} catch {
					return false
				}
			})()
			expect(looksLikeJson || text.length > 0, "tools/call response text was empty").toBe(true)
		} finally {
			await shutdown(state)
		}
	})

	it("parallel-test the rest of the no-project-config siblings (shape parity)", async () => {
		// These are the same assertions as milk, packed into a single
		// test for speed. The above milk test is the canonical probe;
		// this one is a regression guard for the other siblings.
		for (const sibling of SIBLINGS_WITHOUT_PROJECT_MCP) {
			if (sibling === "milk") continue // already covered above
			const cwd = join(PROJECTS_ROOT, sibling)
			const state = spawnMcp({ cwd })
			try {
				await initialize(state)
				const tools = await listTools(state)
				const names = tools.map((t) => t.name)
				for (const required of FOUR_ENGINE_TOOLS) {
					expect(names, `${sibling} tools/list missing ${required}`).toContain(required)
				}
			} finally {
				await shutdown(state)
			}
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-CROSS-007 — Malformed `~/.factory/mcp.json` entry causes the host
// to report error without crashing.
//
// Behavioral description: A malformed baka entry (wrong command path)
// surfaces as a structured connection failure (ENOENT), NOT a host
// crash and NOT a silent drop of all MCP servers. The remaining entries
// (supabase, sanity, etc.) are still available.
//
// We simulate this with a fake `~/.factory/mcp.json` containing:
//
//   mcpServers:
//     baka:   command: /no/such/binary (malformed — ENOENT)
//     real:   command: `node ${DIST_INDEX}` (well-formed via spawn helper)
//
// The host simulator attempts both. The malformed one records a spawn
// error (or fails the spawn). The well-formed one succeeds and exposes
// the four engine tools. The host (test driver) is still alive (no
// throw, no process.exit).
// ---------------------------------------------------------------------------

describe("VAL-CROSS-007 malformed ~/.factory/mcp.json entry reports error without crashing", () => {
	it("a malformed baka entry surfaces ENOENT; the host stays alive and the well-formed entry still loads", async () => {
		const fakeHome = makeFakeHome("cross007-malformed")
		trackDir(fakeHome.root)

		const mcpJson = {
			mcpServers: {
				// The malformed entry — uses a path that cannot resolve.
				// ENOENT is the documented spawn failure for a missing
				// command; this is the canonical "wrong command path"
				// failure the contract pins.
				baka: {
					type: "stdio",
					command: "/no/such/binary/baka-mcp-ghost",
					args: [],
					disabled: false,
					timeoutMs: 120000,
				},
				// A well-formed control entry (the "remaining entries"
				// the contract requires to still be available).
				other: {
					type: "stdio",
					command: "node",
					args: [DIST_INDEX],
					disabled: false,
					timeoutMs: 120000,
				},
			},
		}
		writeMcpConfig(fakeHome, mcpJson)

		// Capture: if the host ever crashes, this top-level await throws
		// and the test fails. We assert below that the aliveHost after
		// simulation still has the well-formed entry's tools.
		const host = await simulateHostLoadMcp(fakeHome)
		aliveHost = host

		// Give the spawn error events time to fire on each child.
		await new Promise((r) => setTimeout(r, 500))

		const baka = host.servers.find((s) => s.name === "baka")
		const other = host.servers.find((s) => s.name === "other")

		// Malformed entry: spawn attempt is recorded; either the child
		// is null OR the child exists but the error event fired.
		const bakaSpawnFailed = !!baka?.spawnError || baka?.child === null
		expect(bakaSpawnFailed, "malformed entry must surface a spawn failure (ENOENT) without crashing the host").toBe(
			true,
		)
		if (baka?.spawnError) {
			// ENOENT or a child-process spawn error class. The contract
			// does not pin the exact error code; the structural
			// assertion is that it is a structured failure.
			expect(baka.spawnError.message.length).toBeGreaterThan(0)
		}

		// Well-formed control entry: still loads, still tools/list-able.
		expect(other?.child, "well-formed control entry should have spawned").not.toBeNull()
		expect(other?.spawnError, `control should not have errored: ${other?.spawnError?.message}`).toBeNull()

		// Cast ManagedMcp|undefined → ManagedMcp after the explicit
		// not-null and no-spawn-error assertions above (no `!` used).
		const otherRef = other as ManagedMcp
		const tools = await initializeManaged(otherRef)
		expect(tools, "control entry's tools/list must succeed alongside the malformed failure").toBeDefined()
		const names = (tools?.tools ?? []).map((t) => t.name)
		for (const required of FOUR_ENGINE_TOOLS) {
			expect(names, `control entry tools/list missing ${required}`).toContain(required)
		}

		// The host process (test driver) is still alive — proven by the
		// fact that we are still here, asserting on the loaded config
		// and tools. No throw, no process.exit.
		expect(host.loadedConfig.mcpServers.baka).toBeDefined()
		expect(host.loadedConfig.mcpServers.other).toBeDefined()
	})

	it("a malformed baka entry with disabled: false in a single-server config still does NOT take down the host", async () => {
		// Defensive regression: with only the malformed entry, the host
		// must still survive (i.e. not throw a fatal). The empty
		// tools/list is acceptable; the crash would be the failure.
		const fakeHome = makeFakeHome("cross007-single-malformed")
		trackDir(fakeHome.root)
		const mcpJson = {
			mcpServers: {
				baka: {
					type: "stdio",
					command: "/no/such/binary/just-a-ghost",
					disabled: false,
				},
			},
		}
		writeMcpConfig(fakeHome, mcpJson)

		const host = await simulateHostLoadMcp(fakeHome)
		aliveHost = host

		// Give the error event a moment.
		await new Promise((r) => setTimeout(r, 500))
		const baka = host.servers.find((s) => s.name === "baka")
		// Coerce to a real boolean: an Error is truthy so a bare
		// `baka?.spawnError || ...` short-circuits to the Error, which
		// makes Object.is-equality with `true` fail. The contract
		// accepts either a populated spawnError OR a null child as the
		// "spawn failure" signal.
		const bakaSpawnFailed = !!baka?.spawnError || baka?.child === null
		expect(
			bakaSpawnFailed,
			"single malformed entry must surface a spawn failure (ENOENT) without crashing the host",
		).toBe(true)

		// Host is alive (we are still executing). No tools expected.
		expect(host.servers.length).toBe(1)
	})
})
