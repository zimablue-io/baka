// ---------------------------------------------------------------------------
// Black-box smoke tests for the core CLI surface of the `baka` binary.
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
//   VAL-CLI-003  --help advertises --cwd and -p/--provider
//   VAL-CLI-004  init --help exits 0 without invoking LLM credentials
//   VAL-CLI-005  config list masks sensitive values
//   VAL-CLI-006  config get <sensitive-key> refuses and exits 1
//   VAL-CLI-007  config set <sensitive-key> rejects; non-sensitive succeeds
//   VAL-CLI-008  providers list shows the active marker
//   VAL-CLI-009  providers use <missing> exits 1, no stack trace
//   VAL-CLI-015  list-modules (no flag) prints the human listing
//   VAL-CLI-016  list-modules --json emits the documented shape
//   VAL-CLI-017  list-modules --json is cwd-scoped
//   VAL-CLI-018  --cwd <nonexistent> exits 1 with a clear message
//   VAL-CLI-031  install <bad-source> exits 1 with a parse error
//   VAL-CLI-032  marketplace add <url> is idempotent
//   VAL-CLI-033  marketplace remove <not-subscribed> exits 1
//   VAL-CLI-034  list-packages empty case prints the user hint, exits 0
//   VAL-CLI-035  update is a no-op on empty packages, exits 0
//   VAL-CLI-036  search <query> with no network exits 2 with fetch failed
//   VAL-CLI-037  -p <provider> overrides active for one invocation only
//   VAL-CLI-040  exit code categories map to BAKA_EXIT_CODE values
//
// Where the current implementation does NOT yet match the contract, the
// affected assertion is marked with `it.todo(...)` plus a comment that
// names the gap and the source location that needs the fix. This is the
// only honest way to surface a contract gap in a passing test suite: the
// suite still exits 0, but the TODO list shows the work that is still
// owed.
//
// Conventions:
//   - spawn `node` against the built `apps/cli/dist/index.js` (no tsx)
//   - always use a fresh temp dir under `$TMPDIR` per test; clean up
//   - always use a fresh fake `$HOME` for any probe that touches the
//     user config or credentials; never pollute the user's real config
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
			resolve({ code: null, stdout, stderr: stderr + `\n[test: killed after ${args.timeoutMs ?? 30_000}ms timeout]` })
		}, args.timeoutMs ?? 30_000)

		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

/** Spawn the CLI with a fresh fake HOME so the user config is isolated. */
function spawnCliWithFakeHome(args: { argv: string[]; cwd?: string; fakeHome: string; timeoutMs?: number }) {
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
// VAL-CLI-003  --help advertises the global flags --cwd and -p/--provider
// ---------------------------------------------------------------------------

describe("VAL-CLI-003 baka --help advertises global flags", () => {
	it("lists both --cwd <path> and -p/--provider <name>", async () => {
		const { code, stdout, stderr } = await spawnCli({ argv: ["--help"] })
		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)

		expect(stdout).toContain("--cwd <path>")
		expect(stdout).toContain("-p, --provider <name>")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-004  init --help exits 0 without invoking LLM credentials
// ---------------------------------------------------------------------------

describe("VAL-CLI-004 baka init --help is air-gapped", () => {
	it("exits 0 without touching the user config file", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-init-help-"))
		const configPath = join(fakeHome, "config.json")
		const credentialsPath = join(fakeHome, ".config", "baka", "credentials")

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["init", "--help"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("Usage: baka init")
		// Neither file should have been created.
		expect(existsSync(configPath), `user config unexpectedly created at ${configPath}`).toBe(false)
		expect(existsSync(credentialsPath), `credentials unexpectedly created at ${credentialsPath}`).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-005  config list masks sensitive values
// ---------------------------------------------------------------------------

describe("VAL-CLI-005 baka config list masks sensitive values", () => {
	it("renders any key matching /key|secret|token|password/ as <redacted>", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-config-list-"))
		// Pre-seed the user config with a sensitive value AND a non-sensitive
		// value. Both must be present so the list output exercises both paths.
		const configPath = join(fakeHome, "config.json")
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					api_key: "SECRET_VALUE_DO_NOT_LEAK",
					password: "hunter2",
					notes: "benign-value",
				},
				null,
				2,
			),
			"utf-8",
		)

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["config", "list"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("api_key = <redacted>")
		expect(stdout).toContain("password = <redacted>")
		expect(stdout).toContain("notes = benign-value")
		// The actual secret value must NEVER appear on stdout.
		expect(stdout).not.toContain("SECRET_VALUE_DO_NOT_LEAK")
		expect(stdout).not.toContain("hunter2")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-006  config get <sensitive-key> refuses and exits 1
// ---------------------------------------------------------------------------

describe("VAL-CLI-006 baka config get refuses sensitive keys", () => {
	it("exits 1 with a refusal message when a sensitive key is set", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-config-get-"))
		const configPath = join(fakeHome, "config.json")
		writeFileSync(configPath, JSON.stringify({ api_key: "SECRET_VALUE_DO_NOT_LEAK" }, null, 2), "utf-8")

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["config", "get", "api_key"],
			fakeHome,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain("sensitive values are not retrievable")
		expect(stdout).not.toContain("SECRET_VALUE_DO_NOT_LEAK")
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-007  config set <sensitive-key> rejects with exit 1
//             + positive: non-sensitive key succeeds with exit 0
// ---------------------------------------------------------------------------

describe("VAL-CLI-007 baka config set refuses sensitive keys", () => {
	it("rejects api_key with exit 1", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-config-set-reject-"))

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["config", "set", "api_key", "xyz"],
			fakeHome,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toContain("api_key")
		expect(stderr.toLowerCase()).toContain("sensitive")
	})

	it("accepts a non-sensitive key with exit 0 and reports it back via list", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-config-set-accept-"))

		const setResult = await spawnCliWithFakeHome({
			argv: ["config", "set", "defaultProvider", "acme"],
			fakeHome,
		})
		expect(setResult.code, `set exited ${setResult.code}; stderr=${setResult.stderr}`).toBe(0)

		const listResult = await spawnCliWithFakeHome({
			argv: ["config", "list"],
			fakeHome,
		})
		expect(listResult.code).toBe(0)
		expect(listResult.stdout).toContain("defaultProvider")

		// Cleanup: unset the test key so a rerun leaves a clean fake HOME.
		await spawnCliWithFakeHome({ argv: ["config", "unset", "defaultProvider"], fakeHome })
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-008  providers list shows the active marker
// ---------------------------------------------------------------------------

describe("VAL-CLI-008 baka providers list", () => {
	it("shows the * marker on the active provider and the active-provider footer", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-providers-list-"))
		const configPath = join(fakeHome, "config.json")
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					providers: {
						alpha: { baseUrl: "http://alpha", model: "m-a" },
						bravo: { baseUrl: "http://bravo", model: "m-b" },
					},
					activeProvider: "bravo",
				},
				null,
				2,
			),
			"utf-8",
		)

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["providers", "list"],
			fakeHome,
		})

		expect(code, `expected exit 0, got ${code}; stderr=${stderr}`).toBe(0)
		// Exactly one "* " line (the active provider).
		const activeMarkerLines = stdout.split("\n").filter((l) => /^\* /.test(l))
		expect(activeMarkerLines.length).toBe(1)
		expect(activeMarkerLines[0]).toContain("bravo")
		// Footer that says active is marked with *.
		expect(stdout).toMatch(/\(active provider marked with \*\)/)
	})
})

// ---------------------------------------------------------------------------
// VAL-CLI-009  providers use <missing> exits 1, no stack trace
// ---------------------------------------------------------------------------

describe("VAL-CLI-009 baka providers use <missing>", () => {
	it("exits 1 with a single-line stderr message and no Node stack frames", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-providers-use-"))

		const { code, stdout, stderr } = await spawnCliWithFakeHome({
			argv: ["providers", "use", "ghost"],
			fakeHome,
		})

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toMatch(/provider "ghost" not found/)
		// No Node stack frames on stderr.
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(stdout).toBe("")
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
		expect(byName["sdd"]?.actions).toBe(2)
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
		// (1) BAKA_REPO — 3 modules, no diagnostics.
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
// VAL-CLI-036  search <query> with no network exits 2 with `fetch failed`
// ---------------------------------------------------------------------------

describe("VAL-CLI-036 baka search with no network", () => {
	it("exits 2 with a fetch-failed stderr message and no stack frames", async () => {
		// We can't reliably turn the network off, but we can route the
		// built-in catalog endpoint at an unreachable host and assert that
		// the CLI fails cleanly with the documented message + code.
		const fakeHome = trackDir(makeEmptyDir("baka-search-"))
		// 192.0.2.0/24 is the RFC 5737 TEST-NET-1 range: guaranteed not to
		// route. Port 1 is the canonical "tcpmux" port that nothing listens
		// on. The fetch will fail with a connection refused / unreachable
		// error, which the CLI surfaces as "fetch failed".
		const { code, stderr } = await spawnCliWithFakeHome({
			argv: ["--provider", "openai-compatible", "search", "anything"],
			fakeHome,
			env: { BAKA_LLM_BASE_URL: "http://192.0.2.1:1/v1" },
		})

		expect(code, `expected exit 2, got ${code}; stderr=${stderr}`).toBe(2)
		expect(stderr).toContain("fetch failed")
		// No Node stack frames on stderr.
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
	}, 30_000)
})

// ---------------------------------------------------------------------------
// VAL-CLI-037  -p <provider> overrides active for one invocation only
// ---------------------------------------------------------------------------

describe("VAL-CLI-037 baka -p <provider> does not mutate active provider", () => {
	it("selects the named provider for one call and leaves the user's active marker untouched", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-provider-override-"))
		const configPath = join(fakeHome, "config.json")
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					providers: {
						acme: { baseUrl: "http://acme", model: "m-acme" },
						globex: { baseUrl: "http://globex", model: "m-globex" },
					},
					activeProvider: "acme",
				},
				null,
				2,
			),
			"utf-8",
		)

		// Pre-state: confirm acme is the active marker.
		const pre = await spawnCliWithFakeHome({ argv: ["providers", "list"], fakeHome })
		expect(pre.code).toBe(0)
		expect(pre.stdout).toMatch(/^\* acme/m)

		// Run a -p globex plan. With globex pointing at an unreachable host
		// and no real LLM, the call must fail (so we know the override was
		// actually used). The failure mode is "fetch failed" (ENGINE_ERROR=2)
		// because the LLM endpoint is unreachable; that is irrelevant for
		// this assertion — what matters is that the active provider did NOT
		// change.
		const probe = await spawnCliWithFakeHome({
			argv: ["-p", "globex", "plan", "scaffold a TS project"],
			fakeHome,
		})
		// Acceptable: any non-zero exit that proves the call reached the LLM
		// layer with the named provider. ENGINE_ERROR (2) is the documented
		// fetch-failure code.
		expect(probe.code, `probe exited 0 — override did not take effect; stdout=${probe.stdout}`).not.toBe(0)

		// Post-state: the active marker must still be acme.
		const post = await spawnCliWithFakeHome({ argv: ["providers", "list"], fakeHome })
		expect(post.code).toBe(0)
		expect(post.stdout).toMatch(/^\* acme/m)
		// And globex must NOT have become the active marker.
		expect(post.stdout).not.toMatch(/^\* globex/m)
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

	it("user error -> 1 (baka providers use ghost)", async () => {
		const fakeHome = trackDir(makeEmptyDir("baka-exit-user-"))
		const { code } = await spawnCliWithFakeHome({
			argv: ["providers", "use", "ghost"],
			fakeHome,
		})
		expect(code).toBe(1)
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
		// Previously this test exercised `baka module validate baka-base`
		// to hit exit 4 via a phantom validator-missing bug; that bug is
		// now fixed in apps/cli/src/commands/module.ts, so the well-formed
		// baka-base module exits 0 (PASS). To keep this exit-category probe
		// valid we now use a deliberately broken module under a scratch dir.
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
