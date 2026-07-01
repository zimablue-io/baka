// ---------------------------------------------------------------------------
// Black-box smoke tests for the core CLI surface of the `baka` binary
// after the role-keyed config refactor.
//
// Every probe in this file spawns the BUILT artifact
// (`apps/cli/dist/index.js`) as a subprocess — never `tsx` against source,
// never in-process. That is the contract this suite pins: the binary
// behaves as documented, regardless of how it is built.
//
// Coverage map (per `validation-contract.md`):
//
//   VAL-CLI-001  --help boots and lists subcommands
//   VAL-CLI-002  --version matches the package.json version field
//   VAL-CLI-003  --help advertises --cwd
//   VAL-CLI-004  init --help exits 0 without writing the user config file
//   VAL-CLI-015  list-modules (no flag) prints the human listing
//   VAL-CLI-016  list-modules --json emits the documented shape (3 modules)
//   VAL-CLI-017  list-modules --json is cwd-scoped (3 modules in BAKA_REPO)
//   VAL-CLI-018  --cwd <nonexistent> exits 1 with a clear message
//   VAL-CLI-031  install <bad-source> exits 1 with a parse error
//   VAL-CLI-032  marketplace add <url> is idempotent
//   VAL-CLI-033  marketplace remove <not-subscribed> exits 1
//   VAL-CLI-034  list-packages empty case prints the user hint, exits 0
//   VAL-CLI-035  update is a no-op on empty packages, exits 0
//   VAL-CLI-040  exit code categories map to BAKA_EXIT_CODE values
//   VAL-ROLE-001 baka roles (no config) — missing LLM config error
//   VAL-ROLE-002 baka roles (full config) — prints both roles, masks apiKey
//   VAL-ROLE-003 baka role worker --field model --value foo — mutates the field
//   VAL-ROLE-004 baka role nonexistent — exits 1
//   VAL-ROLE-005 baka --help does not mention providers/config subcommands
//
// Where the current implementation does NOT yet match the contract, the
// affected assertion is marked with `it.todo(...)` plus a comment that
// names the gap and the source location that needs the fix.
//
// Conventions:
//   - spawn `node` against the built `apps/cli/dist/index.js` (no tsx)
//   - always use a fresh temp dir under `$TMPDIR` per test; clean up
//   - always use a fresh fake `$HOME` for any probe that touches the
//     user config; never pollute the user's real config
//   - capture stdout and stderr separately; assert on each
//   - 30-second timeouts per test (the suite is hermetic; failures
//     should be fast)
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const CLI_PACKAGE_JSON = join(BAKA_REPO, "apps", "cli", "package.json")
const MCP_DIST_INDEX = join(BAKA_REPO, "apps", "mcp", "dist", "index.js")
const EMPTY_CWD = join(tmpdir(), "baka-cli-smoke-empty")

/** Spawn the built CLI and resolve with the captured stdout, stderr, and exit code. */
function spawnCli(args: {
	argv: string[]
	cwd?: string
	env?: Record<string, string>
	timeoutMs?: number
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const env: NodeJS.ProcessEnv = {
		// Keep PATH resolvable but isolate user-state dirs.
		...process.env,
		...args.env,
	}
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
			resolve({ code: null, stdout, stderr: `${stderr}\n[test: killed after ${args.timeoutMs ?? 30_000}ms timeout]` })
		}, args.timeoutMs ?? 30_000)

		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

/**
 * Write a baka config to <home>/.baka/config.json with the role-keyed
 * shape. Both blocks are optional; defaults populate every documented
 * field. apiKey lives inline inside the role block.
 */
function seedRoleConfig(
	home: string,
	cfg: {
		worker?: {
			baseUrl: string
			model: string
			apiKey?: string
			temperature?: number
			maxTokens?: number
			timeoutMs?: number
		}
		validator?: {
			baseUrl: string
			model: string
			apiKey?: string
			temperature?: number
			maxTokens?: number
			timeoutMs?: number
		}
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
			temperature: cfg.worker.temperature ?? 0,
			maxTokens: cfg.worker.maxTokens ?? 8192,
			timeoutMs: cfg.worker.timeoutMs ?? 120_000,
		}
	}
	if (cfg.validator) {
		out.validator = {
			baseUrl: cfg.validator.baseUrl,
			model: cfg.validator.model,
			apiKey: cfg.validator.apiKey ?? "test-validator-key",
			temperature: cfg.validator.temperature ?? 0,
			maxTokens: cfg.validator.maxTokens ?? 8192,
			timeoutMs: cfg.validator.timeoutMs ?? 120_000,
		}
	}
	writeFileSync(join(dir, "config.json"), JSON.stringify(out, null, 2))
}

/** Spawn the CLI with a fresh fake HOME so the user config is isolated. */
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

/** Create a fresh empty temp dir; returns its path. Caller is responsible for cleanup. */
function makeEmptyDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

/** Track every temp dir we create so we can clean them all up in afterEach. */
const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

// ---------------------------------------------------------------------------
// Test fixture prep
// ---------------------------------------------------------------------------

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	if (!existsSync(EMPTY_CWD)) {
		mkdirSync(EMPTY_CWD, { recursive: true })
	}
})

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// VAL-CLI-001  --help boots and lists subcommands
// ---------------------------------------------------------------------------

describe("VAL-CLI-001 baka --help", () => {
	it("exits 0 with the documented subcommand names visible on stdout", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["--help"] })

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stderr).toBe("")
		expect(stdout).toContain("Usage: baka")
		for (const cmd of ["init", "list-modules", "plan", "apply", "validate", "marketplace", "search", "Commands:"]) {
			expect(stdout, `expected stdout to mention "${cmd}"`).toContain(cmd)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-002  --version matches the package.json version field
// ---------------------------------------------------------------------------

describe("VAL-CLI-002 baka --version", () => {
	it("matches the apps/cli/package.json version", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["--version"] })
		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stderr).toBe("")

		const pkg = JSON.parse(readFileSync(CLI_PACKAGE_JSON, "utf-8")) as { version: string }
		const expected = pkg.version
		expect(stdout.trim()).toBe(expected)
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-003  --help advertises the --cwd flag
// ---------------------------------------------------------------------------

describe("VAL-CLI-003 baka --help advertises global flags", () => {
	it("lists --cwd <path>", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["--help"] })
		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("--cwd <path>")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-004  init --help exits 0 without writing the user config file
// ---------------------------------------------------------------------------

describe("VAL-CLI-004 baka init --help is air-gapped", () => {
	it("exits 0 without touching the user config file", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-init-help-"))
		const configPath = join(fakeHome, ".baka", "config.json")
		mkdirSync(join(fakeHome, ".baka"), { recursive: true })

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["init", "--help"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("Usage: baka init")
		// The user config file should not have been created.
		expect(existsSync(configPath), `user config unexpectedly created at ${configPath}`).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-005  baka --help does not mention providers/config subcommands
// ---------------------------------------------------------------------------

describe("VAL-ROLE-005 baka --help does not mention `providers` or `config` subcommands", () => {
	it("stdout does not contain the legacy subcommand names as commands", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["--help"] })
		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		// The legacy subcommands `baka providers` and `baka config` are
		// removed in the role-keyed refactor. The output may contain
		// words that happen to include the substring "providers" or
		// "config" (e.g. "configuration", "configured"); assert on the
		// exact subcommand names, not the bare substrings.
		expect(stdout, "stdout mentions `providers` subcommand").not.toMatch(/^\s+providers\s/m)
		expect(stdout, "stdout mentions `config` subcommand").not.toMatch(/^\s+config\s/m)
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-015  list-modules (no flag) prints the human listing
// ---------------------------------------------------------------------------

describe("VAL-CLI-015 baka list-modules (human)", () => {
	it("prints `Found N module(s):` and one block per module with name + version", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["list-modules"] })

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toMatch(/Found \d+ module\(s\):/)
		expect(stdout).toContain("baka-base")
		expect(stdout).toContain("sdd")
		expect(stdout).toContain("ts-style")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-016  list-modules --json emits the documented shape
// ---------------------------------------------------------------------------

describe("VAL-CLI-016 baka list-modules --json shape", () => {
	it("emits {modules, diagnostics}; each module has name, version, description, actions, uri", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["list-modules", "--json"] })

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)

		const parsed = JSON.parse(stdout) as {
			modules: Array<{ name: string; version: string; description: string; actions: number; uri: string }>
			diagnostics: unknown[]
		}
		expect(parsed.modules).toHaveLength(3)
		expect(parsed.diagnostics).toEqual([])

		const byName = Object.fromEntries(parsed.modules.map((m) => [m.name, m]))
		expect(byName["baka-base"]?.uri).toBe("baka://module/baka-base/manifest")
		expect(byName["baka-base"]?.actions).toBe(3)
		expect(byName.sdd?.actions).toBe(2)
		expect(byName["ts-style"]?.actions).toBe(2)

		for (const m of parsed.modules) {
			expect(typeof m.name).toBe("string")
			expect(typeof m.version).toBe("string")
			expect(typeof m.description).toBe("string")
			expect(typeof m.actions).toBe("number")
			expect(m.uri).toBe(`baka://module/${m.name}/manifest`)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-017  list-modules --json is cwd-scoped
// ---------------------------------------------------------------------------

describe("VAL-CLI-017 baka list-modules --json is cwd-scoped", () => {
	it("discovers 3 modules from BAKA_REPO and 0 from an empty cwd (with a no-modules diagnostic)", async () => {
		// (1) BAKA_REPO — 3 modules (baka-base, sdd, ts-style),
		//     no diagnostics.
		const repoProbe = await spawnCli({ argv: ["list-modules", "--json"] })
		expect(repoProbe.code, `stderr=${repoProbe.stderr}`).toBe(0)
		const repoParsed = JSON.parse(repoProbe.stdout) as {
			modules: unknown[]
			diagnostics: Array<{ rule: string }>
		}
		expect(repoParsed.modules).toHaveLength(3)
		expect(repoParsed.diagnostics).toEqual([])

		// (2) Empty cwd — 0 modules + no-modules diagnostic.
		const emptyProbe = await spawnCli({ argv: ["list-modules", "--json"], cwd: EMPTY_CWD })
		expect(emptyProbe.code, `stderr=${emptyProbe.stderr}`).toBe(0)
		const emptyParsed = JSON.parse(emptyProbe.stdout) as {
			modules: unknown[]
			diagnostics: Array<{ rule: string }>
		}
		expect(emptyParsed.modules).toEqual([])
		expect(emptyParsed.diagnostics.length).toBeGreaterThan(0)
		expect(emptyParsed.diagnostics[0].rule).toBe("no-modules")

		// (3) Empty cwd via --cwd flag — same shape as (2); proves the flag
		//     and the process cwd both route through the same discovery path.
		const cwdFlagProbe = await spawnCli({ argv: ["--cwd", EMPTY_CWD, "list-modules", "--json"] })
		expect(cwdFlagProbe.code, `stderr=${cwdFlagProbe.stderr}`).toBe(0)
		const cwdFlagParsed = JSON.parse(cwdFlagProbe.stdout) as {
			modules: unknown[]
			diagnostics: Array<{ rule: string }>
		}
		expect(cwdFlagParsed.modules).toEqual([])
		expect(cwdFlagParsed.diagnostics[0].rule).toBe("no-modules")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-018  --cwd <nonexistent> exits 1 with a clear message
// ---------------------------------------------------------------------------

describe("VAL-CLI-018 baka --cwd <nonexistent>", () => {
	it("exits 1 and names the missing path on stderr (no Node stack frames)", async () => {
		const missingPath = "/no/such/path/for/baka/cli/smoke"
		const { code, stdout, stderr } = await spawnCli({
			argv: ["--cwd", missingPath, "list-modules"],
		})
		expect(code, `unexpected code; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain("cwd does not exist")
		expect(stderr).toContain(missingPath)
		// Stdout must not leak a successful no-op result.
		expect(stdout).toBe("")
		// No Node stack frames on stderr.
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-031  install <bad-source> exits 1 with a parse error
// ---------------------------------------------------------------------------

describe("VAL-CLI-031 baka install <bad-source>", () => {
	it("exits 1 with a parse-error stderr message", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-install-bad-"))
		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["install", "not-a-real-source"],
			fakeHome,
		})
		expect(code, `unexpected code; stderr=${stderr}`).toBe(1)
		// The parse-error explanation should reach the user verbatim.
		expect(stderr.toLowerCase()).toContain("unrecognized source")
		// No Node stack frames on stderr.
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(stdout).toBe("")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-032  marketplace add <url> is idempotent
// ---------------------------------------------------------------------------

describe("VAL-CLI-032 baka marketplace add <url>", () => {
	it("adds the URL once and treats the second add as a no-op", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-marketplace-add-"))
		const url = "https://example.com/catalog.json"

		const first = await spawnCliWithFakeHome({ argv: ["marketplace", "add", url], fakeHome })
		expect(first.code, `first add exited ${first.code}; stderr=${first.stderr}`).toBe(0)
		expect(first.stdout).toContain(`added catalog: ${url}`)

		const second = await spawnCliWithFakeHome({ argv: ["marketplace", "add", url], fakeHome })
		expect(second.code, `second add exited ${second.code}; stderr=${second.stderr}`).toBe(0)
		expect(second.stdout).toContain(`already subscribed: ${url}`)

		// Verify the catalog list still contains exactly one entry for this URL.
		const list = await spawnCliWithFakeHome({ argv: ["marketplace", "list"], fakeHome })
		expect(list.code, `list exited ${list.code}; stderr=${list.stderr}`).toBe(0)
		const occurrences = list.stdout.split("\n").filter((l) => l.trim() === url).length
		expect(occurrences).toBe(1)

		// Cleanup: remove the catalog so a rerun leaves a clean fake HOME.
		await spawnCliWithFakeHome({ argv: ["marketplace", "remove", url], fakeHome })
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-033  marketplace remove <not-subscribed> exits 1
// ---------------------------------------------------------------------------

describe("VAL-CLI-033 baka marketplace remove <not-subscribed>", () => {
	it("exits 1 with a clear not-subscribed message", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-marketplace-remove-"))

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["marketplace", "remove", "https://example.com/not-subscribed.json"],
			fakeHome,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain("not subscribed")
		expect(stderr).toContain("https://example.com/not-subscribed.json")
		// No mutation: the catalog list still reports no catalogs.
		const list = await spawnCliWithFakeHome({ argv: ["marketplace", "list"], fakeHome })
		expect(list.code).toBe(0)
		expect(list.stdout).toContain("no subscribed catalogs")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-034  list-packages empty case prints the user hint, exits 0
// ---------------------------------------------------------------------------

describe("VAL-CLI-034 baka list-packages empty case", () => {
	it("prints the empty-state hint and exits 0", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["list-packages"] })

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("no installed packages")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-035  update is a no-op on empty packages, exits 0
// ---------------------------------------------------------------------------

describe("VAL-CLI-035 baka update on empty packages", () => {
	it("prints the no-op message and exits 0", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-update-"))

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["update"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		// Accept either "nothing to update" or "no packages to update".
		expect(stdout.toLowerCase()).toMatch(/(nothing|no packages) to update/)
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-040  Exit code categories map to BAKA_EXIT_CODE values
// ---------------------------------------------------------------------------

describe("VAL-CLI-040 exit code categories", () => {
	it("success -> 0 (baka --help)", async () => {
		const { code } = await spawnCli({ argv: ["--help"] })
		expect(code).toBe(0)
	})

	it("user error -> 1 (baka role nonexistent — missing role)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-exit-user-"))
		// Seed the role-keyed config so the role-keyed loadLLMConfig does
		// not short-circuit with a missing-LLM error first.
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://x", model: "m" },
			validator: { baseUrl: "http://x", model: "m" },
		})
		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "nonexistent"],
			fakeHome,
		})
		expect(code, `expected exit 1, got ${code}; stderr=${stderr}`).toBe(1)
	})

	it("engine error -> 2 (baka apply <missing>)", async () => {
		const { code, stderr } = await spawnCli({
			argv: ["apply", "/no/such/plan.plan.json"],
		})
		expect(code, `unexpected code; stderr=${stderr}`).toBe(2)
	})

	it("validation error -> 4 (baka module validate reports structural defects)", async () => {
		// The `baka module validate <name>` structural check fails (exits 4)
		// when a module declares an action without an `action.ts` file.
		// Build a scratch module with a missing action.ts and validate it.
		const scratch = trackDir(makeEmptyDir("baka-cli-smoke-validation-"))
		const moduleDir = join(scratch, "modules", "broken-mod")
		mkdirSync(join(moduleDir, "missing-action"), { recursive: true })
		writeFileSync(
			join(moduleDir, "manifest.ts"),
			`export const Manifest = {
  name: "broken-mod",
  version: "0.1.0",
  description: "deliberately broken module for the validation-error smoke test",
  dependencies: [],
  conflictsWith: [],
  actions: [
    {
      id: "missing-action",
      description: "declared action whose action.ts is intentionally absent",
      requiresReasoning: false,
      filePatterns: [],
      validators: [],
      params: [],
    },
  ],
  moduleValidators: [],
}
`,
			"utf-8",
		)

		const { code, stdout, stderr } = await spawnCli({
			argv: ["module", "validate", "broken-mod"],
			cwd: scratch,
		})
		expect(code, `unexpected code; stdout=${stdout}; stderr=${stderr}`).toBe(4)
		// The validation output should mention the missing action.
		expect(stdout).toContain("missing-action")
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-001  baka roles (no config) — missing LLM config error
// ---------------------------------------------------------------------------

describe("VAL-ROLE-001 baka roles (no config)", () => {
	it("exits 1 with a `missing LLM config` diagnostic pointing at `baka init`", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-roles-empty-"))

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["roles"],
			fakeHome,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toMatch(/missing LLM config/)
		expect(stderr).toContain("baka init")
		// No Node stack frames.
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-002  baka roles (full config) — prints both roles, masks apiKey
// ---------------------------------------------------------------------------

describe("VAL-ROLE-002 baka roles (full config)", () => {
	it("exits 0, prints `worker` and `validator` lines, masks the apiKey value", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-roles-full-"))
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
		// apiKey values must be masked — neither secret appears verbatim.
		expect(stdout, "worker apiKey not masked").not.toContain("SECRET-WORKER-KEY")
		expect(stdout, "validator apiKey not masked").not.toContain("SECRET-VALIDATOR-KEY")
		// Some form of redaction must be visible (e.g. ***, <set>, or <redacted>).
		const masked = /(\*\*\*|<set>|<redacted>|set|redact)/i
		expect(stdout, "no redaction marker found on stdout").toMatch(masked)
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-003  baka role worker --field model --value foo — mutates the field
// ---------------------------------------------------------------------------

describe("VAL-ROLE-003 baka role worker --field model --value foo", () => {
	it("mutates the worker block's `model` field and leaves other fields unchanged", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-set-"))
		seedRoleConfig(fakeHome, {
			worker: { baseUrl: "http://worker.example/v1", model: "old-worker-model" },
			validator: { baseUrl: "http://validator.example/v1", model: "old-validator-model" },
		})
		const configPath = join(fakeHome, ".baka", "config.json")
		const beforeRaw = readFileSync(configPath, "utf-8")
		const before = JSON.parse(beforeRaw) as { worker: { model: string }; validator: { model: string } }

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["role", "worker", "--field", "model", "--value", "foo"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)

		const afterRaw = readFileSync(configPath, "utf-8")
		const after = JSON.parse(afterRaw) as { worker: { model: string; baseUrl: string }; validator: { model: string } }
		expect(after.worker.model).toBe("foo")
		// Other worker fields are preserved.
		expect(after.worker.baseUrl).toBe(before.worker.baseUrl ?? "http://worker.example/v1")
		// The validator block is untouched.
		expect(after.validator.model).toBe(before.validator.model ?? "old-validator-model")
	})
})

// ---------------------------------------------------------------------------
// VAL-ROLE-004  baka role nonexistent — exits 1 with `unknown role` or similar
// ---------------------------------------------------------------------------

describe("VAL-ROLE-004 baka role nonexistent", () => {
	it("exits 1 with an `unknown role` (or similar) stderr message and no stack frames", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-role-unknown-"))
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
// VAL-CLI-038  Dist artifact is a single ESM file that boots without tsx
// VAL-CLI-039  Dist does not leak dev-only modules
// ---------------------------------------------------------------------------

describe("VAL-CLI-038/039 dist artifact sanity", () => {
	it("apps/cli/dist/index.js starts with the node shebang", () => {
		// Read just the first byte chunk (cheap and exact).
		const fd = require("node:fs") as typeof import("node:fs")
		const handle = fd.openSync(DIST_INDEX, "r")
		try {
			const buf = Buffer.alloc(64)
			fd.readSync(handle, buf, 0, 64, 0)
			const firstLine = buf.toString("utf-8").split("\n", 1)[0]
			expect(firstLine).toBe("#!/usr/bin/env node")
		} finally {
			fd.closeSync(handle)
		}
	})

	it("apps/cli/dist/index.js boots via `node ... --help` with no tsx on the path", async () => {
		// We pass a deliberately empty PATH that contains only node's
		// directory. This forces the test to fail loudly if the dist ever
		// starts requiring tsx at runtime.
		const nodeDir = process.execPath ? require("node:path").dirname(process.execPath) : "/usr/bin"
		const isolatedPath = nodeDir

		const { code, stdout, stderr } = await new Promise<{
			code: number | null
			stdout: string
			stderr: string
		}>((resolve) => {
			const child: ChildProcess = spawn("node", [DIST_INDEX, "--help"], {
				env: { ...process.env, PATH: isolatedPath },
			})
			let so = ""
			let se = ""
			child.stdout?.on("data", (b: Buffer) => (so += b.toString()))
			child.stderr?.on("data", (b: Buffer) => (se += b.toString()))
			child.on("close", (c) => resolve({ code: c, stdout: so, stderr: se }))
		})

		expect(code, `boot exited ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("Usage: baka")
	})

	it("neither dist file references a dev-only module (tsx, vitest, nodemon, playwright)", () => {
		const devOnlyPattern = /(?:require|from)\s*['"](?:tsx|vitest|nodemon|playwright)/
		for (const file of [DIST_INDEX, MCP_DIST_INDEX]) {
			const src = readFileSync(file, "utf-8")
			expect(devOnlyPattern.test(src), `${file} references a dev-only module`).toBe(false)
		}
	})
})
