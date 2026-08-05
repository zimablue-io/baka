// ---------------------------------------------------------------------------
// Regression test for the EMPTY_CWD cleanup contract.
//
// `apps/cli/vitest.config.ts` sets `fileParallelism: false`, so files run
// alphabetically; this file's `z-` prefix places it after the suites that
// create constant-path EMPTY_CWD dirs in their `beforeAll`:
//
//   - engine-smoke.test.ts creates `$TMPDIR/baka-engine-smoke-empty`
//   - cli-smoke.test.ts   creates `$TMPDIR/baka-cli-smoke-empty`
//
// Each suite's `afterAll` removes its own EMPTY_CWD so a single suite
// run leaves zero tmp dirs behind. This regression test guards against
// accidental removal of either `afterAll` block.
//
// On a fresh checkout the dirs do not exist at all, so the assertions
// pass trivially; the value of the test is that a future agent who
// deletes either `afterAll` will see this file fail when the suite runs
// end-to-end, instead of discovering the leak on the next dev-machine
// reboot.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const EMPTY_CWDS = [
	{ label: "engine-smoke.test.ts", path: join(tmpdir(), "baka-engine-smoke-empty") },
	{ label: "cli-smoke.test.ts", path: join(tmpdir(), "baka-cli-smoke-empty") },
] as const

describe("test tmp dir cleanup regression — EMPTY_CWD is removed by afterAll", () => {
	for (const { label, path } of EMPTY_CWDS) {
		it(`${label} removed its EMPTY_CWD (${path})`, () => {
			expect(existsSync(path), `${label} afterAll did not remove ${path}`).toBe(false)
		})
	}
})
