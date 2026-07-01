// ---------------------------------------------------------------------------
// Role-keyed CLI smoke tests for the baka binary.
//
// Spawns the BUILT artifact (`apps/cli/dist/index.js`) as a subprocess,
// never tsx against source, never in-process. Mirrors the helper patterns
// used in cli-smoke.test.ts and engine-smoke.test.ts.
//
// Coverage map (per `validation-contract.md`, VAL-ROLE-*):
//
//   VAL-ROLE-001 baka roles (no config) — exits 1 with
//              `missing LLM config: worker role not configured` on stderr.
//   VAL-ROLE-002 baka roles (full config) — exits 0, prints `worker` and
//              `validator` lines, masks the apiKey value.
//   VAL-ROLE-003 baka role worker --field model --value foo — mutates
//              the worker block's `model` field; leaves other fields untouched.
//   VAL-ROLE-004 baka role nonexistent — exits 1 with a clear error and
//              no Node stack frames.
//   VAL-ROLE-005 baka --help does not mention `providers` or `config`
//              as legacy subcommands.
//
// The CLI must be built (via `pnpm --filter baka run build`) before this
// suite runs. The `beforeAll` block fails loudly if the built artifact is
// missing.
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

/**
 * Seed a role-keyed baka config at <home>/.baka/config.json. Both blocks
 * are optional. The role-keyed shape inlines apiKey inside the role block.
 */
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

function makeEmptyDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
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

// ---------------------------------------------------------------------------
// VAL-ROLE-001
// ---------------------------------------------------------------------------

describe("VAL-ROLE-001 baka roles (no config)", () => {
	it("exits 1 with a `missing LLM config` diagnostic pointing at `baka init`", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-smoke-empty-"))

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["roles"],
			fakeHome,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toMatch(/missing LLM config/)
		expect(stderr).toContain("baka init")
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(stdout).toBe("")
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-002
// ---------------------------------------------------------------------------

describe("VAL-ROLE-002 baka roles (full config)", () => {
	it("exits 0, prints worker + validator lines, masks apiKey values", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-smoke-full-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://worker.example/v1", model: "worker-model", apiKey: "SECRET-WORKER-KEY" },
			validator: {
				baseUrl: "http://validator.example/v1",
				model: "validator-model",
				apiKey: "SECRET-VALIDATOR-KEY",
			},
		})

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["roles"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("worker")
		expect(stdout).toContain("validator")
		// Neither apiKey value should appear verbatim — masking is required.
		expect(stdout, "worker apiKey not masked").not.toContain("SECRET-WORKER-KEY")
		expect(stdout, "validator apiKey not masked").not.toContain("SECRET-VALIDATOR-KEY")
		// Some redaction marker should be visible.
		expect(stdout.toLowerCase()).toMatch(/(\*\*\*|<set>|<redacted>|set|redact)/)
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-003
// ---------------------------------------------------------------------------

describe("VAL-ROLE-003 baka role worker --field model --value foo", () => {
	it("mutates the worker block's model field and leaves other fields unchanged", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-smoke-mutate-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://worker.example/v1", model: "old-worker-model" },
			validator: { baseUrl: "http://validator.example/v1", model: "old-validator-model" },
		})
		const configPath = join(fakeHome, ".baka", "config.json")
		const before = JSON.parse(readFileSync(configPath, "utf-8")) as {
			worker: { model: string; baseUrl: string }
			validator: { model: string }
		}

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "model", "--value", "foo"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)

		const after = JSON.parse(readFileSync(configPath, "utf-8")) as {
			worker: { model: string; baseUrl: string }
			validator: { model: string }
		}
		expect(after.worker.model).toBe("foo")
		// Other worker fields preserved.
		expect(after.worker.baseUrl).toBe(before.worker.baseUrl)
		// Validator block untouched.
		expect(after.validator.model).toBe(before.validator.model)
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-004
// ---------------------------------------------------------------------------

describe("VAL-ROLE-004 baka role nonexistent", () => {
	it("exits 1 with `unknown role` (or similar) on stderr, no stack frames", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-smoke-bad-role-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://x", model: "m" },
			validator: { baseUrl: "http://x", model: "m" },
		})

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "nonexistent"],
			fakeHome,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr.toLowerCase()).toMatch(/unknown role|invalid role|role "nonexistent"/)
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-005
// ---------------------------------------------------------------------------

describe("VAL-ROLE-005 baka --help does not mention providers/config subcommands", () => {
	it("stdout does not name `providers` or `config` as subcommands", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["--help"] })
		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		// Assert on the exact subcommand names, not bare substrings (which
		// would also match documentation prose like "configuration").
		expect(stdout, "stdout mentions `providers` subcommand").not.toMatch(/^\s+providers\s/m)
		expect(stdout, "stdout mentions `config` subcommand").not.toMatch(/^\s+config\s/m)
	})
})
