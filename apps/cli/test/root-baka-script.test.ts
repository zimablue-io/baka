// ---------------------------------------------------------------------------
// Black-box test for the repo-root `pnpm baka` script (VAL-FOUND-036).
//
// The documented invocation form is `pnpm baka -- <cmd>`. pnpm appends a
// literal "--" to the script's argv, so the root script must strip it
// before it reaches commander — otherwise every doc string that uses the
// `--` form fails with `error: unknown command '--'`.
//
// These probes spawn the real `pnpm baka` script from the repo root, the
// exact surface the docs promise.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")

function spawnPnpmBaka(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("pnpm", ["baka", ...argv], { cwd: BAKA_REPO, env: process.env })
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		child.on("close", (code) => resolve({ code, stdout, stderr }))
	})
}

describe("VAL-FOUND-036 root `pnpm baka` script arg forwarding", () => {
	it("`pnpm baka -- --help` exits 0 and prints commander help (no `unknown command '--'`)", async () => {
		const { code, stdout, stderr } = await spawnPnpmBaka(["--", "--help"])
		expect(code, `expected exit 0; stdout=${stdout}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("Usage: baka")
		expect(stdout).not.toContain("unknown command")
	}, 60_000)

	it("`pnpm baka -- --version` exits 0 and prints the version", async () => {
		const { code, stdout, stderr } = await spawnPnpmBaka(["--", "--version"])
		expect(code, `expected exit 0; stdout=${stdout}; stderr=${stderr}`).toBe(0)
		// pnpm prefixes its own `> baka@0.1.0 baka ...` banner lines; the
		// CLI's version is the last non-empty line.
		const lastLine = stdout.trim().split("\n").pop() ?? ""
		expect(lastLine.trim()).toMatch(/^\d+\.\d+\.\d+$/)
	}, 60_000)

	it("`pnpm baka -- plan --help` reaches the plan subcommand help", async () => {
		const { code, stdout, stderr } = await spawnPnpmBaka(["--", "plan", "--help"])
		expect(code, `expected exit 0; stdout=${stdout}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("Usage: baka plan")
	}, 60_000)

	it("`pnpm baka --help` without the separator still works", async () => {
		const { code, stdout, stderr } = await spawnPnpmBaka(["--help"])
		expect(code, `expected exit 0; stdout=${stdout}; stderr=${stderr}`).toBe(0)
		expect(stdout).toContain("Usage: baka")
	}, 60_000)
})
