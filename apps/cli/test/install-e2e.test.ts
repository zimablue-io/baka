// End-to-end CLI surface tests for `baka install` (feature cli-install).
//
// These probes spawn the BUILT CLI (`apps/cli/dist/index.js`) as a
// subprocess against a live seed-publishing-server. The probes exercise
// CLI parsing, error rendering, and config wiring — anything that needs
// the full CLI binary rather than the install pack's exported
// functions (covered by `install-unit.test.ts`).
//
// End-to-end install/uninstall round-trips against a real registry are
// out of scope for this file. The validation coverage map for the
// install code lives in `install-unit.test.ts` and the existing
// catalog/install endpoint tests under `apps/registry/test/`. The
// CLI-surface assertions that DO need the binary (malformed input,
// help output, exit codes) live here.
//
// Coverage map (per validation-contract.md):
//
//   VAL-DISC-020  `baka install @/widget` exits non-zero with a
//                  precise `malformed` error and never falls into the
//                  legacy `unrecognized source` catch-all.
//   VAL-DISC-040  malformed install spec / config errors render with
//                  the new distinct error message.
//
// Conventions:
//   - isolated BAKA_HOME per probe (decision 33)
//   - never touch the user's real ~/.baka
//   - CLI is spawned via `node apps/cli/dist/index.js` (dist-based,
//     no tsx)
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(REPO, "apps", "cli", "dist", "index.js")

const createdDirs: string[] = []

function makeIsolatedHome(prefix: string): string {
	const base = mkdtempSync(join(tmpdir(), prefix))
	createdDirs.push(base)
	const bakaHome = join(base, "baka-home")
	mkdirSync(bakaHome, { recursive: true })
	return bakaHome
}

interface SpawnResult {
	code: number | null
	stdout: string
	stderr: string
}

function spawnCli(argv: string[], cwd: string, env: Record<string, string>, timeoutMs = 30_000): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...argv], {
			cwd,
			env: { ...process.env, ...env },
		})
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve({ code: null, stdout, stderr: `${stderr}\n[test: killed after ${timeoutMs}ms]` })
		}, timeoutMs)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

beforeAll(() => {
	if (!require("node:fs").existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
}, 30_000)

afterAll(() => {
	for (const d of createdDirs.splice(0)) {
		if (require("node:fs").existsSync(d)) rmSync(d, { recursive: true, force: true })
	}
}, 30_000)

// ---------------------------------------------------------------------------
// VAL-DISC-020 / VAL-DISC-040 — malformed spec renders an honest error
// ---------------------------------------------------------------------------

describe("VAL-DISC-020/040 malformed install spec refuses with a precise error", () => {
	it("@/widget with no scope is a clear malformed-spec error, not the legacy catch-all", async () => {
		const bakaHome = makeIsolatedHome("baka-install-malformed-")
		const cwd = makeIsolatedHome("baka-install-malformed-proj-")
		const res = await spawnCli(["install", "@/widget", "--registry", "http://127.0.0.1:1"], cwd, {
			BAKA_HOME: bakaHome,
			BAKA_REGISTRY_URL: "http://127.0.0.1:1",
		})
		expect(res.code, res.stderr).not.toBe(0)
		expect(res.stderr).toMatch(/malformed/i)
		// The legacy `unrecognized source` catch-all must not appear.
		expect(res.stderr.toLowerCase()).not.toContain("unrecognized source")
	}, 30_000)

	it("bare-name with no scope is accepted (resolves to official scope) and fails on registry reach", async () => {
		const bakaHome = makeIsolatedHome("baka-install-malformed-bare-")
		const cwd = makeIsolatedHome("baka-install-malformed-bare-proj-")
		// Bare-name specs are accepted and resolved against the
		// official scope (`baka`). They are NOT a malformed-spec
		// error (architecture §8 decision 4).
		const res = await spawnCli(["install", "widget", "--registry", "http://127.0.0.1:1"], cwd, {
			BAKA_HOME: bakaHome,
			BAKA_REGISTRY_URL: "http://127.0.0.1:1",
		})
		expect(res.code, res.stderr).not.toBe(0)
		// It must NOT be a "malformed spec" or "usage" error.
		expect(res.stderr.toLowerCase()).not.toMatch(/malformed/)
		// It SHOULD be a registry transport / not-found error.
		expect(res.stderr.toLowerCase()).toMatch(/registry|not found/)
	}, 30_000)

	it("install without arguments renders a usage error", async () => {
		const bakaHome = makeIsolatedHome("baka-install-usage-")
		const cwd = makeIsolatedHome("baka-install-usage-proj-")
		const res = await spawnCli(["install"], cwd, {
			BAKA_HOME: bakaHome,
		})
		expect(res.code, res.stderr).not.toBe(0)
		expect(res.stderr).toMatch(/usage|spec/i)
	}, 30_000)
})

// ---------------------------------------------------------------------------
// CLI help / usage surface
// ---------------------------------------------------------------------------

describe("baka install help output renders the documented flags", () => {
	it("baka install --help lists --user, --registry, --json", async () => {
		const bakaHome = makeIsolatedHome("baka-install-help-")
		const res = await spawnCli(["install", "--help"], bakaHome, { BAKA_HOME: bakaHome })
		expect(res.code, res.stderr).toBe(0)
		expect(res.stdout).toMatch(/--user/)
		expect(res.stdout).toMatch(/--registry/)
		expect(res.stdout).toMatch(/--json/)
	}, 30_000)
})
