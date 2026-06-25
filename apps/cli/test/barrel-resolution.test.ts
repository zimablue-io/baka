// ---------------------------------------------------------------------------
// Test A — barrel exports loadSession (proves the workflow barrel is
// reachable under tsx with a STATIC import).
//
// What it asserts:
//   - The workflow barrel `workflows/module-management/src/index.ts` exposes
//     both `loadSession` (re-exported from `./design`) and
//     `executeCreateModuleWorkflow` (re-exported from `./create-module`)
//     when consumed by another package via a STATIC `import` statement
//     under tsx (the same way the CLI's TypeScript source is compiled and
//     consumed).
//
// Failure mode it covers:
//   - `workflows/module-management/src/index.ts` currently has
//     `export * from "./design"` (no `/index.ts` extension). Under
//     tsx/Node ESM, this fails to resolve to a file: tsx looks for
//     `./design.ts` (which does not exist) and the star re-export yields
//     undefined for every design symbol. `loadSession` is therefore
//     `undefined` when the package is consumed via static import.
//
// Why subprocess + tsx (not in-process vitest dynamic import):
//   - vitest/vite-node is lenient about extension-less TS imports and
//     rewrites the resolution graph, so a vitest dynamic import passes
//     even when the barrel is broken. The actual production scenario
//     (tsx-driven CLI boot, or any future consumer that does a static
//     `import` from the package) is strict-Node-ESM, and that's the
//     behavior this test pins down.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const PROBE_DIR = join(__dirname, "_barrel_probe_tmp")
const PROBE_PATH = join(PROBE_DIR, "probe.mts")
const TSX_BIN = join(__dirname, "..", "node_modules", ".bin", "tsx")
const CLI_CWD = join(__dirname, "..")

const PROBE_SOURCE = [
	"// Probe script: static import of the workflow package via tsx.",
	"// Mirrors how the CLI source statically imports workflow packages.",
	'import * as m from "@repo/module-management-workflow"',
	'console.log("loadSession=" + typeof m.loadSession)',
	'console.log("executeCreateModuleWorkflow=" + typeof m.executeCreateModuleWorkflow)',
	"",
].join("\n")

describe("@repo/module-management-workflow barrel resolution (tsx, static import)", () => {
	beforeAll(() => {
		if (!existsSync(PROBE_DIR)) mkdirSync(PROBE_DIR, { recursive: true })
		writeFileSync(PROBE_PATH, PROBE_SOURCE, "utf-8")
	})

	afterEach(() => {
		if (existsSync(PROBE_DIR)) {
			rmSync(PROBE_DIR, { recursive: true, force: true })
		}
	})

	it("resolves loadSession and executeCreateModuleWorkflow from the barrel", () => {
		expect(existsSync(TSX_BIN)).toBe(true)

		const result = spawnSync(TSX_BIN, [PROBE_PATH], {
			encoding: "utf-8",
			cwd: CLI_CWD,
			env: process.env,
		})

		// If tsx failed to start, surface that as the test failure rather
		// than silently passing on stdout.
		if (result.error) {
			throw result.error
		}

		// The probe must exit cleanly under tsx. A non-zero exit (e.g.
		// ERR_MODULE_NOT_FOUND) means the barrel is broken in a way
		// worse than "loadSession undefined" — it would crash the CLI
		// at boot. We surface both stdout and stderr so the failure
		// message is actionable.
		expect(
			result.status,
			`tsx exited with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		).toBe(0)

		// loadSession must be exported as a function from the barrel.
		// Under the broken barrel, tsx's static import silently turns
		// the star re-export of `./design` into undefined symbols, so
		// this line fails.
		expect(
			result.stdout,
			`Expected loadSession=function in tsx stdout, got:\n${result.stdout}`,
		).toContain("loadSession=function")

		// executeCreateModuleWorkflow is the other named export the
		// barrel contract promises. Pin it down too so a partial fix
		// (only `./create-module.ts` extension) doesn't accidentally
		// regress the `./design` side.
		expect(
			result.stdout,
			`Expected executeCreateModuleWorkflow=function in tsx stdout, got:\n${result.stdout}`,
		).toContain("executeCreateModuleWorkflow=function")
	}, 30_000)
})
