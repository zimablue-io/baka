// Black-box tests for the CLI's --cwd flag consistency on `baka module`
// subcommands (feature `cli-cwd-consistency`, misc-found milestone).
//
// Bug: `baka module validate|list-actions|test` (and `module edit`) read
// `process.cwd()` directly, ignoring the global --cwd flag the CLI
// advertises. Every other `baka` subcommand already honors the flag. The
// fix is to thread an explicit `cwd` through the module command handlers
// and pass it from `index.ts`.
//
// Bug (root script): `pnpm baka` runs the CLI via
// `pnpm --filter baka exec tsx src/index.ts ...`, which sets the spawned
// process's cwd to `apps/cli`. From the repo root that means every
// `baka module ...` invocation resolves modules from `apps/cli` instead
// of the user's invocation directory. The root `scripts/baka.mjs` wrapper
// must forward the invoker's cwd (via INIT_CWD or by explicit chdir).
//
// The black-box probes here spawn the BUILT artifact
// (`apps/cli/dist/index.js`) as a subprocess with a fake HOME, then assert
// that:
//   (a) `baka --cwd <fixtureDir> module validate <name>` finds the fixture
//       from any process cwd (proves the --cwd flag is honored);
//   (b) `baka --cwd <fixtureDir> module list-actions <name>` lists the
//       fixture's actions;
//   (c) `baka --cwd <fixtureDir> module test <name> --action <id>` runs
//       the fixture's action;
//   (d) `pnpm baka <cmd>` invoked from a non-baka-repo cwd (with
//       INIT_CWD pointing at a fixture project) operates on that fixture
//       project, not on `apps/cli`.
//
// The wrapper-script test uses Node directly (not pnpm) because the unit
// under test is `scripts/baka.mjs`. The `baka` invocations inside that
// probe use the built dist via `pnpm --filter baka exec node
// apps/cli/dist/index.js` so the dist rebuild requirement (services.yaml
// note) is honored.

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const BAKA_MJS = join(BAKA_REPO, "scripts", "baka.mjs")

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}
function makeEmptyDir(prefix: string): string {
	return trackDir(mkdtempSync(join(tmpdir(), prefix)))
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	if (!existsSync(BAKA_MJS)) {
		throw new Error(`root script not found at ${BAKA_MJS}`)
	}
})

afterAll(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

/** Spawn the built CLI and resolve with stdout/stderr/exit code. */
function spawnCli(args: {
	argv: string[]
	cwd: string
	fakeHome?: string
	timeoutMs?: number
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(args.fakeHome ? { HOME: args.fakeHome, XDG_CONFIG_HOME: args.fakeHome, XDG_DATA_HOME: args.fakeHome } : {}),
	}
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...args.argv], {
			cwd: args.cwd,
			env,
		})
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve({ code: null, stdout, stderr: `${stderr}\n[test: killed after ${args.timeoutMs ?? 30_000}ms]` })
		}, args.timeoutMs ?? 30_000)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

/**
 * Write a minimal valid fixture module under `<projectDir>/.baka/modules/<name>`.
 * The module declares one non-reasoning action that writes a single
 * marker file, so `baka module test` can prove the loader resolved the
 * fixture through the project-marketplace scope.
 */
function writeFixtureModule(projectDir: string, name: string, markerFile: string): void {
	const moduleDir = join(projectDir, ".baka", "modules", name)
	mkdirSync(join(moduleDir, "echo", "validators"), { recursive: true })
	writeFileSync(
		join(moduleDir, "manifest.ts"),
		`export const Manifest = {
	name: ${JSON.stringify(name)},
	version: "0.1.0",
	description: ${JSON.stringify(`fixture for ${name}`)},
	dependencies: [],
	conflictsWith: [],
	actions: [
		{
			id: "echo",
			description: "writes a marker file so the runner can prove it ran",
			requiresReasoning: false,
			filePatterns: [${JSON.stringify(markerFile)}],
			validators: [],
			params: [],
		},
	],
	moduleValidators: [],
}
`,
		"utf-8",
	)
	writeFileSync(
		join(moduleDir, "echo", "action.ts"),
		`import { writeFileSync } from "node:fs"
import { join } from "node:path"

export const echoAction = {
	name: ${JSON.stringify(`${name}.echo`)},
	execute: async (_input, state) => {
		writeFileSync(join(state.targetDirectory, ${JSON.stringify(markerFile)}), "ok\\n", "utf-8")
		return { success: true, output: ${JSON.stringify(markerFile)}, compensationData: null }
	},
	compensate: async () => {},
}
`,
		"utf-8",
	)
	writeFileSync(
		join(moduleDir, "echo", "validators", "has-output.ts"),
		`export const hasOutput = {
	name: ${JSON.stringify(`${name}.echo.has-output`)},
	validate: async (_input, _state, _output) => ({ kind: "pass", diagnostics: [] }),
}
`,
		"utf-8",
	)
}

// ---------------------------------------------------------------------------
// (a) `baka --cwd <fixtureDir> module validate <name>` finds the fixture
// even when process.cwd() != fixtureDir.
// ---------------------------------------------------------------------------
describe("cli-cwd-consistency / baka --cwd <dir> module validate honors --cwd", () => {
	it("finds a fixture installed in the --cwd dir from a different process cwd", async () => {
		const fixtureDir = makeEmptyDir("baka-cwd-consistency-validate-")
		const foreignCwd = makeEmptyDir("baka-cwd-consistency-validate-foreign-")
		const fakeHome = makeEmptyDir("baka-cwd-consistency-validate-home-")
		writeFixtureModule(fixtureDir, "cwd-fixture-mod", "validate-marker.txt")

		const { code, stdout, stderr } = await spawnCli({
			argv: ["--cwd", fixtureDir, "module", "validate", "cwd-fixture-mod", "--json"],
			cwd: foreignCwd,
			fakeHome,
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)
		const parsed = JSON.parse(stdout) as { module: string; valid: boolean; errors: string[] }
		expect(parsed.module).toBe("cwd-fixture-mod")
		expect(parsed.valid, `errors: ${parsed.errors.join("; ")}`).toBe(true)
		expect(parsed.errors).toEqual([])
	})

	it("exits 1 with 'module not found' when neither --cwd nor process.cwd can resolve the name", async () => {
		const fixtureDir = makeEmptyDir("baka-cwd-consistency-validate-missing-")
		const foreignCwd = makeEmptyDir("baka-cwd-consistency-validate-missing-foreign-")
		const fakeHome = makeEmptyDir("baka-cwd-consistency-validate-missing-home-")
		// fixtureDir is empty; foreignCwd is empty; no project marketplace anywhere.

		const { code, stdout, stderr } = await spawnCli({
			argv: ["--cwd", fixtureDir, "module", "validate", "cwd-fixture-mod", "--json"],
			cwd: foreignCwd,
			fakeHome,
		})

		expect(code).not.toBe(0)
		// In --json mode the error message is wrapped in the JSON payload on
		// stdout; the human-readable form (no --json) writes to stderr. Either
		// surface should name the missing module.
		const combined = stdout + stderr
		expect(combined).toContain("module not found")
		expect(combined).toContain("cwd-fixture-mod")
	})
})

// ---------------------------------------------------------------------------
// (b) `baka --cwd <fixtureDir> module list-actions <name>` honors --cwd.
// ---------------------------------------------------------------------------
describe("cli-cwd-consistency / baka --cwd <dir> module list-actions honors --cwd", () => {
	it("lists the fixture's actions when --cwd points at the project marketplace", async () => {
		const fixtureDir = makeEmptyDir("baka-cwd-consistency-list-")
		const foreignCwd = makeEmptyDir("baka-cwd-consistency-list-foreign-")
		const fakeHome = makeEmptyDir("baka-cwd-consistency-list-home-")
		writeFixtureModule(fixtureDir, "cwd-fixture-mod", "list-marker.txt")

		const { code, stdout, stderr } = await spawnCli({
			argv: ["--cwd", fixtureDir, "module", "list-actions", "cwd-fixture-mod"],
			cwd: foreignCwd,
			fakeHome,
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("module: cwd-fixture-mod")
		expect(stdout).toContain("- echo:")
	})
})

// ---------------------------------------------------------------------------
// (c) `baka --cwd <fixtureDir> module test <name> --action <id>` honors --cwd.
// ---------------------------------------------------------------------------
describe("cli-cwd-consistency / baka --cwd <dir> module test honors --cwd", () => {
	it("runs the fixture's action when --cwd points at the project marketplace", async () => {
		const fixtureDir = makeEmptyDir("baka-cwd-consistency-test-")
		const foreignCwd = makeEmptyDir("baka-cwd-consistency-test-foreign-")
		const fakeHome = makeEmptyDir("baka-cwd-consistency-test-home-")
		writeFixtureModule(fixtureDir, "cwd-fixture-mod", "test-marker.txt")

		const { code, stdout, stderr } = await spawnCli({
			argv: ["--cwd", fixtureDir, "module", "test", "cwd-fixture-mod", "--action", "echo", "--input", "{}"],
			cwd: foreignCwd,
			fakeHome,
		})

		expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("RESULT:")
		expect(stdout).toContain("test-marker.txt")
	})
})

// ---------------------------------------------------------------------------
// (d) `pnpm baka <cmd>` from the repo root operates on the repo root.
// `scripts/baka.mjs` must pass INIT_CWD (the invoker's cwd) to the spawned
// CLI; the spawned `tsx src/index.ts` (or built dist via pnpm exec) must
// read the invoker's cwd, not `apps/cli`.
// ---------------------------------------------------------------------------
describe("cli-cwd-consistency / scripts/baka.mjs passes the invoker's cwd through", () => {
	it("`baka --cwd <dir> list-modules --json` reports the fixture project's modules when invoked via scripts/baka.mjs", async () => {
		const fixtureDir = makeEmptyDir("baka-cwd-consistency-wrapper-list-")
		const fakeHome = makeEmptyDir("baka-cwd-consistency-wrapper-list-home-")
		writeFixtureModule(fixtureDir, "wrapper-fixture-mod", "wrapper-list-marker.txt")

		// scripts/baka.mjs does `pnpm --filter baka exec tsx src/index.ts <args>`.
		// From a different process cwd, with --cwd <fixtureDir>, it should see the
		// fixture (not the baka repo's bundled modules).
		const child: ChildProcess = spawn("node", [BAKA_MJS, "--cwd", fixtureDir, "list-modules", "--json"], {
			cwd: BAKA_REPO, // INVOKER'S cwd (the repo root)
			env: {
				...process.env,
				HOME: fakeHome,
				XDG_CONFIG_HOME: fakeHome,
				XDG_DATA_HOME: fakeHome,
				INIT_CWD: BAKA_REPO, // simulate pnpm forwarding the invoker's cwd
			},
		})
		const stdout: string[] = []
		const stderr: string[] = []
		child.stdout?.on("data", (b: Buffer) => stdout.push(b.toString()))
		child.stderr?.on("data", (b: Buffer) => stderr.push(b.toString()))

		const result = await new Promise<{ code: number | null }>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL")
				resolve({ code: null })
			}, 60_000)
			child.on("close", (code) => {
				clearTimeout(timer)
				resolve({ code })
			})
		})
		const outStr = stdout.join("")
		const errStr = stderr.join("")
		expect(result.code, `unexpected exit; stdout=${outStr}; stderr=${errStr}`).toBe(0)

		const parsed = JSON.parse(outStr) as {
			modules: Array<{ name: string }>
			diagnostics: Array<{ rule: string }>
		}
		const names = parsed.modules.map((m) => m.name)
		expect(names).toContain("wrapper-fixture-mod")
		// The fixture project has no bundled modules and no in-tree modules;
		// engine catalog names must not leak.
		expect(names).not.toContain("baka-base")
		expect(names).not.toContain("sdd")
		expect(names).not.toContain("ts-style")
	})
})
