import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { computeDivergencesForTest, renderConsistencyTraceForTest } from "./consistency.js"

function makeRun(idx: number, files: string[], hashes: Record<string, string>) {
	return {
		runIndex: idx,
		planSteps: 1,
		planActions: ["baka-base:scaffold"],
		planParams: { name: "demo" },
		files,
		fileHashes: hashes,
		applyExitCode: 0,
		applyOutput: "ok",
		durationMs: 10,
	}
}

describe("consistency runner", () => {
	test("computeDivergences returns no divergences for identical runs", () => {
		const files = ["/a/package.json", "/a/src/index.ts"]
		const hashes = {
			"/a/package.json": "abc123",
			"/a/src/index.ts": "def456",
		}
		const runs = [makeRun(0, files, hashes), makeRun(1, files, hashes), makeRun(2, files, hashes)]
		expect(computeDivergencesForTest(runs)).toEqual([])
	})

	test("computeDivergences catches file tree differences", () => {
		const a = makeRun(0, ["/a/package.json", "/a/src/index.ts"], { "/a/package.json": "x", "/a/src/index.ts": "y" })
		const b = makeRun(1, ["/a/package.json"], { "/a/package.json": "x" })
		const divs = computeDivergencesForTest([a, b])
		// 1 for the file-tree diff + 1 for the missing file
		expect(divs).toHaveLength(2)
		expect(divs[0]).toContain("file tree differs")
		expect(divs[1]).toContain("/a/src/index.ts missing")
	})

	test("computeDivergences catches hash mismatches", () => {
		const a = makeRun(0, ["/a/x.ts"], { "/a/x.ts": "aaa" })
		const b = makeRun(1, ["/a/x.ts"], { "/a/x.ts": "bbb" })
		const divs = computeDivergencesForTest([a, b])
		expect(divs).toHaveLength(1)
		expect(divs[0]).toContain("hash mismatch on /a/x.ts")
	})

	test("computeDivergences catches plan param differences", () => {
		const a = makeRun(0, ["/a/x.ts"], { "/a/x.ts": "aaa" })
		const b = makeRun(1, ["/a/x.ts"], { "/a/x.ts": "aaa" })
		;(b as { planParams: Record<string, unknown> }).planParams = { name: "different" }
		const divs = computeDivergencesForTest([a, b])
		expect(divs).toHaveLength(1)
		expect(divs[0]).toContain("plan params differ")
	})

	test("renderConsistencyTraceForTest writes a CONSISTENCY-TRACE.json file", () => {
		const dir = join(tmpdir(), `baka-consistency-test-${Date.now()}`)
		mkdirSync(dir, { recursive: true })
		const runs = [makeRun(0, ["/a/x.ts"], { "/a/x.ts": "aaa" }), makeRun(1, ["/a/x.ts"], { "/a/x.ts": "aaa" })]
		const result = {
			passed: true,
			moduleName: "test-mod",
			actionId: "scaffold",
			intent: "make a ts project",
			n: 2,
			perRun: runs,
			divergences: [],
			artifactDir: dir,
		}
		renderConsistencyTraceForTest(result)
		expect(existsSync(join(dir, "CONSISTENCY-TRACE.json"))).toBe(true)
		expect(existsSync(join(dir, "CONSISTENCY.json"))).toBe(true)
		const text = readFileSync(join(dir, "CONSISTENCY-TRACE.json"), "utf-8")
		expect(text).toContain("Consistency trace for test-mod:scaffold")
		expect(text).toContain("Result: PASS")
		rmSync(dir, { recursive: true, force: true })
	})
})
