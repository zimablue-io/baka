// ---------------------------------------------------------------------------
// Regression test for `fix-mcp-version-source`.
//
// Bug: `apps/mcp/src/server.ts:34` previously hardcoded
// `const SERVER_VERSION = "0.1.0"`. After `scripts/release.sh <version>`
// bumped apps/mcp/package.json, the CLI correctly reported the new version
// (it reads package.json at runtime) but the MCP server's `initialize`
// response kept returning the stale hardcoded "0.1.0". This broke
// VAL-CROSS-005 (versioning round-trip) and would have broken VAL-MCP-002
// silently after any version bump.
//
// Fix: SERVER_VERSION is now read from apps/mcp/package.json at runtime
// via `import.meta.url` (same pattern as apps/cli/src/index.ts:30-36).
//
// This file is the focused regression. It exercises the BUILT dist
// (the original bug surfaced in the dist, not in source). Two
// assertions:
//
//   1. Behavioral — spawn the dist, send `initialize`, assert
//      `serverInfo.version === apps/mcp/package.json.version`. The
//      test reads package.json at run time so a future bump + rebuild
//      does not require any test edit; the assertion tracks the
//      single-source-of-truth version automatically.
//
//   2. Structural — the dist file must NOT contain a literal
//      `"0.1.0"` hardcoded as a standalone version string. This is
//      the smoking-gun guard against re-introducing the original bug
//      pattern (a `const X = "0.1.0"` literal in the source that
//      gets baked into the dist). The dist may legitimately contain
//      the substring `"0.1.0"` as part of other strings (e.g. a
//      path or comment), so this assertion is intentionally scoped
//      to the version-shaped context that the original bug produced.
//      Specifically: it asserts the dist does not contain the literal
//      token `SERVER_VERSION = "0.1.0"` (the exact pre-fix form) —
//      which would only appear if the hardcode was re-introduced.
//
// The behavioral assertion is the load-bearing one (it catches the
// actual user-visible regression). The structural one is the belt
// and the suspenders, catching the bug at code-review time too.
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "mcp", "dist", "index.js")
const MCP_PACKAGE_JSON = join(BAKA_REPO, "apps", "mcp", "package.json")
const SOURCE_SERVER = join(BAKA_REPO, "apps", "mcp", "src", "server.ts")

interface SpawnedMcp {
	child: ChildProcess
	stdoutBuf: string
	nextId: number
	responses: Array<{ id: number | string; result?: unknown; error?: unknown }>
}

function spawnMcp(): SpawnedMcp {
	const child: ChildProcess = spawn("node", [DIST_INDEX], {
		cwd: BAKA_REPO,
		stdio: ["pipe", "pipe", "pipe"],
	})
	const state: SpawnedMcp = {
		child,
		stdoutBuf: "",
		nextId: 1,
		responses: [],
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
				state.responses.push(JSON.parse(line))
			} catch {
				// Ignore non-JSON lines.
			}
		}
	})
	return state
}

async function readInitialize(state: SpawnedMcp): Promise<{ serverInfo: { name: string; version: string } }> {
	const id = state.nextId++
	state.child.stdin?.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "version-source-regression", version: "0.0.0" },
			},
		})}\n`,
	)
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		const resp = state.responses.find((r) => r.id === id)
		if (resp) {
			if (resp.error) throw new Error(`initialize returned error: ${JSON.stringify(resp.error)}`)
			return resp.result as { serverInfo: { name: string; version: string } }
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("initialize: no response within 5s")
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

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built MCP dist not found at ${DIST_INDEX}; run \`pnpm --filter @baka/mcp-server build\` first`)
	}
})

afterEach(async () => {
	// No persistent state to clean up — each test spawns and shuts down
	// its own subprocess within the test body via try/finally.
})

// ---------------------------------------------------------------------------
// Behavioral assertion — the load-bearing one.
// ---------------------------------------------------------------------------

describe("fix-mcp-version-source: behavioral regression", () => {
	it("serverInfo.version (built dist) equals apps/mcp/package.json version", async () => {
		const pkg = JSON.parse(readFileSync(MCP_PACKAGE_JSON, "utf-8")) as { version: string }
		const state = spawnMcp()
		try {
			const result = await readInitialize(state)
			expect(result.serverInfo.name).toBe("baka-mcp")
			expect(result.serverInfo.version).toBe(pkg.version)
		} finally {
			await shutdown(state)
		}
	})
})

// ---------------------------------------------------------------------------
// Structural assertion — guard against re-introducing the hardcode.
// ---------------------------------------------------------------------------

describe("fix-mcp-version-source: structural guards", () => {
	it('apps/mcp/src/server.ts does not hardcode `SERVER_VERSION = "0.1.0"`', () => {
		const source = readFileSync(SOURCE_SERVER, "utf-8")
		// The exact pre-fix form. A future contributor who reintroduces
		// the hardcode pattern will trip this. The post-fix form reads
		// the version from package.json at runtime.
		expect(source).not.toMatch(/SERVER_VERSION\s*=\s*["']0\.1\.0["']/)
	})

	it("apps/mcp/dist/index.js does not contain the pre-fix hardcoded token", () => {
		const dist = readFileSync(DIST_INDEX, "utf-8")
		// The pre-fix dist contained the literal
		// `var SERVER_VERSION = "0.1.0"` after tsup's variable
		// rename. Post-fix, the dist reads from package.json
		// at runtime. This guard catches the smoking-gun form.
		expect(dist).not.toMatch(/SERVER_VERSION\s*=\s*["']0\.1\.0["']/)
	})
})
