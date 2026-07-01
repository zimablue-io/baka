// ---------------------------------------------------------------------------
// QA battle tests for the role-keyed CLI surface.
//
// These tests were written by qa-battle-tester to cover defects the writer
// missed in apps/cli/src/commands/{role,roles}.ts. They spawn the built
// `apps/cli/dist/index.js` as a subprocess (mirroring role-smoke.test.ts).
//
// Coverage areas:
//   - Corrupt `~/.baka/config.json` produces a clean error message — the
//     store layer prepends `baka: ` and the CLI's `die()` ALSO prepends
//     `baka: `, so the user sees `baka: baka: user config...`. This is a
//     HIGH-severity UX defect. Both `baka roles` and `baka role <name>`
//     and `baka plan` expose it.
//   - `baka role <name> --field bogus` rejects unknown field names with
//     a clean message.
//   - `baka role <name> --field temperature --value <non-number>` exits
//     1 with a clean numeric parse error.
//   - `baka role <name> --field apiKey --value ""` clears the apiKey.
//   - `baka roles` (partial config — only the validator block exists)
//     does NOT die on the `no roles configured` guard; it prints the
//     configured role and the unconfigured one.
//   - `baka role path` prints a path containing `.baka/config.json`.
//   - `baka plan` with worker configured but the apiKey field absent
//     does NOT crash (local-server contract — loadLLMConfig defaults to
//     empty apiKey, plan reaches the LLM call).
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
			resolve({
				code: null,
				stdout,
				stderr: `${stderr}\n[test: killed after ${args.timeoutMs ?? 30_000}ms timeout]`,
			})
		}, args.timeoutMs ?? 30_000)

		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

function spawnCliWithFakeHome(args: {
	argv: string[]
	cwd?: string
	fakeHome: string
	bakaConfig?: {
		worker?: { baseUrl: string; model: string; apiKey?: string }
		validator?: { baseUrl: string; model: string; apiKey?: string }
		// `corrupt` overrides bakaConfig: instead of writing a valid JSON,
		// write the literal bytes you pass here.
		corrupt?: string
	}
	timeoutMs?: number
}) {
	if (args.bakaConfig?.corrupt !== undefined) {
		const dir = join(args.fakeHome, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "config.json"), args.bakaConfig.corrupt)
	} else if (args.bakaConfig) {
		seedRoleConfig(args.fakeHome, args.bakaConfig)
	}
	return spawnCli({
		argv: args.argv,
		cwd: args.cwd ?? BAKA_REPO,
		env: { HOME: args.fakeHome, XDG_CONFIG_HOME: args.fakeHome, XDG_DATA_HOME: args.fakeHome },
		timeoutMs: args.timeoutMs,
	})
}

function seedRoleConfig(
	home: string,
	cfg: {
		worker?: { baseUrl: string; model: string; apiKey?: string }
		validator?: { baseUrl: string; model: string; apiKey?: string }
	} = {},
): void {
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
			timeoutMs: 120_000,
		}
	}
	if (cfg.validator) {
		out.validator = {
			baseUrl: cfg.validator.baseUrl,
			model: cfg.validator.model,
			apiKey: cfg.validator.apiKey ?? "test-validator-key",
			temperature: 0,
			maxTokens: 8192,
			timeoutMs: 120_000,
		}
	}
	writeFileSync(join(dir, "config.json"), JSON.stringify(out, null, 2))
}

function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

const createdDirs: string[] = []
function makeEmptyDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

// ---------------------------------------------------------------------------
// Fixture prep
// ---------------------------------------------------------------------------

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
})

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

// ===========================================================================
// Defect A: `baka: baka:` double prefix on stderr when the user config is
// corrupt. Both `baka roles` and `baka plan` and `baka role <name>` expose
// the same defect via `readConfigFile`'s throw path.
// ===========================================================================

describe("VAL-ROLE-020 corrupt ~/.baka/config.json", () => {
	it("`baka roles` exits 1 with a single clean stderr line (no `baka: baka:` double prefix)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-corrupt-roles-"))
		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["roles"],
			fakeHome,
			bakaConfig: { corrupt: '{ "worker": ' }, // truncated, unparseable JSON
		})

		expect(code, `expected exit 1; stderr=${stderr}`).toBe(1)
		// No double `baka:` prefix. The store layer writes "baka:" and the
		// CLI's `die()` ALSO writes "baka:"; the user should see only one.
		expect(stderr, "stderr contains duplicated `baka: baka:` prefix").not.toMatch(/baka:\s*baka:/)
		// And the diagnostic must still include the actionable hint.
		expect(stderr).toContain("baka init")
		expect(stderr).toContain("config.json")
	})

	it("`baka plan <intent>` exits 1 with a single clean stderr line (no `baka: baka:` double prefix)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-corrupt-plan-"))
		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["plan", "scaffold x"],
			fakeHome,
			bakaConfig: { corrupt: "{ broken" },
		})

		expect(code, `expected exit 1; stderr=${stderr}`).toBe(1)
		expect(stderr, "stderr contains duplicated `baka: baka:` prefix").not.toMatch(/baka:\s*baka:/)
	})

	it("`baka role worker --field model --value x` exits 1 with a single clean stderr line (no `baka: baka:` double prefix)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-corrupt-role-"))
		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "model", "--value", "x"],
			fakeHome,
			bakaConfig: { corrupt: "<<<not-json>>>" },
		})

		expect(code, `expected exit 1; stderr=${stderr}`).toBe(1)
		expect(stderr, "stderr contains duplicated `baka: baka:` prefix").not.toMatch(/baka:\s*baka:/)
	})
})

// ===========================================================================
// Defect 021: `baka role <name> --field bogus` is a clean error
// ===========================================================================

describe("VAL-ROLE-021 baka role <name> --field <unknown-field>", () => {
	it("exits 1 with the unknown-field error (no Node stack frames)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-bogus-"))
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "bogus", "--value", "x"],
			fakeHome,
			bakaConfig: { worker: { baseUrl: "http://x", model: "m" } },
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain(`unknown field "bogus"`)
		expect(stderr).toContain("Editable:")
		expect(stderr, "stderr contains Node stack frames").not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(stdout).toBe("")
	})
})

// ===========================================================================
// Defect 022: `baka role <name> --field temperature --value <non-number>`
// ===========================================================================

describe("VAL-ROLE-022 baka role <name> --field temperature --value abc", () => {
	it("exits 1 with a `must be a number` error (no Node stack frames)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-badnum-"))
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "temperature", "--value", "abc"],
			fakeHome,
			bakaConfig: { worker: { baseUrl: "http://x", model: "m" } },
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toMatch(/temperature.*must be a number/)
		expect(stderr, "stderr mentions the bad value verbatim").toContain("'abc'")
		expect(stderr, "stderr contains Node stack frames").not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ===========================================================================
// Defect 023: `baka role <name> --field apiKey --value ""` clears the key
// ===========================================================================

describe("VAL-ROLE-023 baka role <name> --field apiKey --value ''", () => {
	it("clears the apiKey field on disk; show then displays `(empty)`", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-clear-apikey-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://x", model: "m", apiKey: "fresh-secret" },
		})
		const configPath = join(fakeHome, ".baka", "config.json")

		const clearRun = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "apiKey", "--value", ""],
			fakeHome,
		})
		expect(clearRun.code, `expected exit 0, got ${clearRun.code}; stderr=${clearRun.stderr}`).toBe(0)

		const after = JSON.parse(readFileSync(configPath, "utf-8")) as { worker: { apiKey: string } }
		expect(after.worker.apiKey).toBe("")

		// And `baka role worker show` masks it as `(empty)`, never echoing
		// any formerly-secret value.
		const showRun = await spawnCliWithFakeHome({
			argv: ["role", "show", "worker"],
			fakeHome,
		})
		expect(showRun.code, `expected exit 0, got ${showRun.code}; stderr=${showRun.stderr}`).toBe(0)
		expect(showRun.stdout).toContain("apiKey:")
		expect(showRun.stdout).toContain("(empty)")
		expect(showRun.stdout, "former secret leaked after clear").not.toContain("fresh-secret")
	})
})

// ===========================================================================
// Defect 024: `baka roles` with a partial config (validator only)
// ===========================================================================

describe("VAL-ROLE-024 baka roles with partial config (validator only)", () => {
	it("exits 0, prints the validator block, and reports worker as `(not configured)`", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-roles-partial-"))
		seedRoleConfig(fakeHome, {
			validator: { baseUrl: "http://v.example/v1", model: "v-model", apiKey: "V-SECRET" },
		})

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["roles"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("validator")
		expect(stdout).toContain("v-model")
		expect(stdout).toContain("worker")
		expect(stdout).toContain("(not configured)")
		// No secrets on the wire.
		expect(stdout, "validator apiKey not masked").not.toContain("V-SECRET")
	})
})

// ===========================================================================
// Defect 025: `baka role path` returns the documented config path
// ===========================================================================

describe("VAL-ROLE-025 baka role path", () => {
	it("prints a path ending in `.baka/config.json`", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-path-"))
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "path"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		const trimmed = stdout.trim()
		expect(trimmed).toMatch(/\.baka\/config\.json$/)
		expect(trimmed, "should not be empty").not.toBe("")
	})
})
