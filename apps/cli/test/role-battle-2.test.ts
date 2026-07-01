// ---------------------------------------------------------------------------
// QA battle tests (round 2) for the role-keyed CLI surface.
//
// These tests target gaps the round-1 suite (role-smoke.test.ts,
// role-battle.test.ts) missed. They spawn the built
// `apps/cli/dist/index.js` as a subprocess (mirroring the same helper
// pattern used in role-battle.test.ts).
//
// Coverage areas (per qa-battle-tester investigation):
//   - `baka role <name>` rejects every name that is not literally in
//     SUPPORTED_ROLES, including the legacy `judge` / `validator-judge`
//     / `worker-mod` families. Round 1 covered only `nonexistent`; this
//     is the broader class.
//   - `baka --help` does not mention the legacy `-p, --provider` flag
//     (round 1 covered `providers` / `config` subcommands but not the
//     legacy global option).
//   - After `baka role worker --field model --value x`, no
//     `~/.baka/credentials` file is created. The legacy `secretsPath()`
//     must be gone for good.
//   - After `baka init`-style write paths, the config file has only
//     role keys (`worker`, `validator`); the legacy `providers` /
//     `activeProvider` / `defaults` keys must NOT be re-introduced.
//   - The `baka roles` command with an empty config (no roles
//     configured) exits 1 with a clean `missing LLM config: ... Run
//     \`baka init\`` message and a `baka: ` prefix applied EXACTLY ONCE
//     (no `baka: baka:` doubling). This is the same defect as the
//     round-1 corrupt-config test, but it bites even on a clean
//     `baka: missing LLM config...` path because the `no roles
//     configured` guard in roles.ts pre-prepends `baka: ` and the
//     CLI's `die()` adds another.
//   - `baka plan` with NO config (no roles configured at all) exits 1
//     with a clean `missing LLM config: ... Run \`baka init\`` line
//     and a single `baka:` prefix.
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

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}
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
// Defect A: `baka role <name>` rejects every name outside SUPPORTED_ROLES
// ===========================================================================

describe("VAL-ROLE-030 baka role <name> with names outside SUPPORTED_ROLES", () => {
	const REJECTED_NAMES = [
		"judge", // hypothetical future role
		"validator-judge", // kebab-case sibling
		"worker-mod", // kebab-case sibling
		"orchestrator", // legacy role name
		"active", // legacy role name
		"openai", // legacy provider alias
		"llama_cpp", // legacy provider alias
		"Worker", // case variant
		"WORKER", // all caps
	]

	for (const name of REJECTED_NAMES) {
		it(`exits 1 with a clear 'unknown role' message for ${JSON.stringify(name)}`, async () => {
			const fakeHome = trackDir(makeEmptyDir(`baka-role-reject-${name}-`))
			const { code, stdout, stderr } = await spawnCliWithFakeHome({
				argv: ["role", name],
				fakeHome,
				bakaConfig: {
					worker: { baseUrl: "http://w", model: "wm" },
					validator: { baseUrl: "http://v", model: "vm" },
				},
			})

			expect(code, `expected exit 1 for ${name}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
			expect(stderr, `expected 'unknown role' for ${name}; got ${stderr}`).toContain("unknown role")
			expect(stderr, `expected the role name in the message; got ${stderr}`).toContain(`"${name}"`)
			expect(stderr, `expected the known-roles hint; got ${stderr}`).toContain("worker")
			expect(stderr, `expected the known-roles hint; got ${stderr}`).toContain("validator")
			// No stack frames.
			expect(stderr, `stderr contains Node stack frames; got ${stderr}`).not.toMatch(/\bat .+\.js:\d+:\d+/)
			expect(stdout, `stdout should be empty for a clean rejection; got ${stdout}`).toBe("")
		})
	}

	it("rejects `baka role <name>` for unknown names even with NO config present", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-reject-noconfig-"))
		// No config at all.
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "judge"],
			fakeHome,
		})

		// The unknown-role check fires BEFORE the role-not-configured check
		// because the role name is invalid for the surface (not just
		// unconfigured). Either error is acceptable, but the user must see
		// a clean single-`baka:` line.
		expect(code, `expected exit 1; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr, "stderr should not double-prefix").not.toMatch(/baka:\s*baka:/)
		expect(stderr).toContain("unknown role")
	})
})

// ===========================================================================
// Defect B: `baka --help` does not mention the legacy `-p, --provider` flag
// ===========================================================================

describe("VAL-ROLE-031 baka --help does not mention the legacy `-p, --provider` flag", () => {
	it("stdout does not contain `-p` or `--provider` as a top-level option", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["--help"] })
		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		// The legacy flag was a top-level option. The new code has none.
		// Assert on the `Options:` section: it should not mention `-p` or
		// `--provider` as a documented flag.
		expect(stdout, "stdout mentions the legacy `-p, --provider` option").not.toMatch(/^\s+-p,\s+--provider\s/m)
		expect(stdout, "stdout mentions the `--provider` option").not.toMatch(/^\s+--provider\s/m)
		expect(stdout, "stdout mentions the `-p` short flag").not.toMatch(/^\s+-p\b/m)
	})

	it("`baka plan --help` does not mention the legacy `--provider` option", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["plan", "--help"] })
		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout, "plan --help mentions the legacy `--provider` option").not.toMatch(/^\s+--provider\s/m)
	})
})

// ===========================================================================
// Defect C: After `baka role worker --field model --value x`, no
// `~/.baka/credentials` file is created.
// ===========================================================================

describe("VAL-ROLE-032 no `~/.baka/credentials` file is created by `baka role <name>`", () => {
	it("does NOT create a credentials file when editing a role's field", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-no-creds-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://w", model: "wm", apiKey: "secret-w" },
		})
		const credentialsPath = join(fakeHome, ".baka", "credentials")

		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "model", "--value", "new-model"],
			fakeHome,
		})
		expect(code, `expected exit 0; stderr=${stderr}`).toBe(0)

		// The legacy code wrote `secrets` to `~/.baka/credentials` with 0600
		// perms. The new code stores the apiKey inline in `config.json`. The
		// credentials file MUST NOT exist after a role edit.
		expect(existsSync(credentialsPath), `credentials file leaked at ${credentialsPath}`).toBe(false)
	})

	it("does NOT create a credentials file when setting apiKey explicitly", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-no-creds-apikey-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://w", model: "wm" },
		})
		const credentialsPath = join(fakeHome, ".baka", "credentials")

		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "apiKey", "--value", "fresh-key"],
			fakeHome,
		})
		expect(code, `expected exit 0; stderr=${stderr}`).toBe(0)

		expect(existsSync(credentialsPath), `credentials file leaked at ${credentialsPath}`).toBe(false)

		// And the apiKey MUST live inline in the config file, not in a
		// separate credentials file.
		const configPath = join(fakeHome, ".baka", "config.json")
		const after = JSON.parse(readFileSync(configPath, "utf-8")) as { worker: { apiKey: string } }
		expect(after.worker.apiKey).toBe("fresh-key")
	})
})

// ===========================================================================
// Defect D: The config file shape after `baka role` writes is role-keyed
// ONLY. No `providers` / `activeProvider` / `defaults` keys are
// introduced.
// ===========================================================================

describe("VAL-ROLE-033 config file shape after `baka role` write", () => {
	it("does NOT introduce `providers`, `activeProvider`, or `defaults` keys", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-shape-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://w", model: "wm", apiKey: "wk" },
		})
		const configPath = join(fakeHome, ".baka", "config.json")

		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "model", "--value", "new-wm"],
			fakeHome,
		})
		expect(code, `expected exit 0; stderr=${stderr}`).toBe(0)

		const after = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>

		// The role-keyed union: only `worker` and `validator` are allowed.
		const allowedKeys = new Set(["worker", "validator"])
		for (const key of Object.keys(after)) {
			expect(allowedKeys.has(key), `unexpected top-level key '${key}' in config.json: ${JSON.stringify(after)}`).toBe(
				true,
			)
		}

		// And explicitly: no legacy keys.
		expect(after, "config.json has a `providers` key").not.toHaveProperty("providers")
		expect(after, "config.json has an `activeProvider` key").not.toHaveProperty("activeProvider")
		expect(after, "config.json has a `defaults` key").not.toHaveProperty("defaults")
	})

	it("does NOT introduce a `providers` key when the validator role block is updated", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-shape-validator-"))
		// Both roles are configured from the start.
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://w", model: "wm", apiKey: "wk" },
			validator: { baseUrl: "http://v-OLD", model: "vm", apiKey: "vk" },
		})
		const configPath = join(fakeHome, ".baka", "config.json")

		// Now write the validator role's baseUrl. The write should preserve
		// the worker block and add only the validator block change.
		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "validator", "--field", "baseUrl", "--value", "http://v-NEW"],
			fakeHome,
		})
		expect(code, `expected exit 0; stderr=${stderr}`).toBe(0)

		const after = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
		expect(Object.keys(after).sort()).toEqual(["validator", "worker"])
		expect(after).not.toHaveProperty("providers")
		expect(after).not.toHaveProperty("activeProvider")
		expect(after).not.toHaveProperty("defaults")
		// The validator block is updated.
		expect((after as { validator: { baseUrl: string } }).validator.baseUrl).toBe("http://v-NEW")
		// The worker block is preserved.
		expect((after as { worker: { baseUrl: string; model: string; apiKey: string } }).worker.baseUrl).toBe("http://w")
		expect((after as { worker: { baseUrl: string; model: string; apiKey: string } }).worker.model).toBe("wm")
		expect((after as { worker: { baseUrl: string; model: string; apiKey: string } }).worker.apiKey).toBe("wk")
	})
})

// ===========================================================================
// Defect E: `baka plan` with no config (no roles configured) exits 1 with
// a single `baka:` prefix. This is the user-facing manifestation of the
// engine's "missing LLM config: worker role not configured" path; the
// CLI's `die()` adds the `baka:` prefix and the user sees EXACTLY ONE
// `baka:` per line.
// ===========================================================================

describe("VAL-ROLE-034 baka plan with no config emits a single `baka:` prefix", () => {
	it("`baka plan <intent>` exits 1 with a clean `baka: missing LLM config...` line", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-plan-no-config-"))
		// No config at all.
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["plan", "scaffold x"],
			fakeHome,
			timeoutMs: 15_000,
		})

		expect(code, `expected exit 1; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr, "stderr should not double-prefix").not.toMatch(/baka:\s*baka:/)
		expect(stderr, "stderr should include the missing-config message").toMatch(/missing LLM config/)
		expect(stderr, "stderr should include the `baka init` hint").toContain("baka init")
		// No Node stack frames.
		expect(stderr, "stderr contains Node stack frames").not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ===========================================================================
// Defect F: `baka roles` with no config (no roles configured) exits 1
// with a single `baka:` prefix. The `no roles configured` guard in
// roles.ts must not double-prefix when the CLI's `die()` runs.
// ===========================================================================

describe("VAL-ROLE-035 baka roles with no config emits a single `baka:` prefix", () => {
	it("`baka roles` exits 1 with a clean `baka: missing LLM config: no roles configured...` line", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-roles-no-config-"))
		// No config at all.
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["roles"],
			fakeHome,
		})

		expect(code, `expected exit 1; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		// This is a separate double-prefix path from the corrupt-config
		// one. The `no roles configured` guard in roles.ts uses its own
		// wording: it says "no roles configured" rather than "<role>
		// role not configured". The CLI's die() adds the `baka:` prefix;
		// the user must see exactly one.
		expect(stderr, "stderr should not double-prefix").not.toMatch(/baka:\s*baka:/)
		expect(stderr, "stderr should mention `baka init`").toContain("baka init")
		expect(stderr, "stderr should mention the missing config").toMatch(/missing LLM config/)
		// No stack frames.
		expect(stderr, "stderr contains Node stack frames").not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ===========================================================================
// Defect G: `baka roles` masks the apiKey for EVERY configured role,
// including the validator role. The legacy code only knew about the
// "active" provider; the new code must apply the masking contract to
// every role.
// ===========================================================================

describe("VAL-ROLE-036 baka roles masks every role's apiKey (not just one)", () => {
	it("masks BOTH worker and validator apiKeys when both are configured", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-roles-mask-both-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://w", model: "wm", apiKey: "SECRET-W-KEY" },
			validator: { baseUrl: "http://v", model: "vm", apiKey: "SECRET-V-KEY" },
		})

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["roles"],
			fakeHome,
		})
		expect(code, `expected exit 0; got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout, "worker apiKey leaked").not.toContain("SECRET-W-KEY")
		expect(stdout, "validator apiKey leaked").not.toContain("SECRET-V-KEY")
		// And the masking token must appear for BOTH roles.
		const maskCount = (stdout.match(/<set>/g) ?? []).length
		expect(maskCount, `expected at least 2 '<set>' markers, got ${maskCount}; stdout=${stdout}`).toBeGreaterThanOrEqual(
			2,
		)
	})
})

// ===========================================================================
// Defect H: `baka role <name> --value ""` for non-apiKey fields is a
// USER_ERROR (the user gave us a bad value). The error must be clean.
// ===========================================================================

describe("VAL-ROLE-037 baka role <name> --value '' (empty) for a non-apiKey field", () => {
	it("exits 1 with a `--value is required` message (no stack frames)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-empty-nonapikey-"))
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "baseUrl", "--value", ""],
			fakeHome,
			bakaConfig: { worker: { baseUrl: "http://w", model: "wm" } },
		})

		expect(code, `expected exit 1; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr, "stderr should not double-prefix").not.toMatch(/baka:\s*baka:/)
		// The CLI's `die()` adds `baka:` exactly once.
		expect(stderr, `stderr should mention 'value is required'; got ${stderr}`).toMatch(/--value is required/)
		expect(stderr, "stderr contains Node stack frames").not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})
