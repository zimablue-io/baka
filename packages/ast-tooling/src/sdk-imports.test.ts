import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { findModuleSdkImports, findRuntimeSdkImports } from "./sdk-imports.js"

describe("findRuntimeSdkImports", () => {
	it.each([
		'import type { ActionStep } from "baka-sdk"',
		"import type { ActionStep } from 'baka-sdk'",
		'import { type ActionStep } from "baka-sdk"',
		'import { type A, type B } from "baka-sdk"',
		'import type * as sdk from "baka-sdk"',
		'import type Default from "baka-sdk"',
		'export type { ActionStep } from "baka-sdk"',
		'import type {\n\tA,\n\tB,\n} from "baka-sdk"',
		'import { type A,\n type B } from "baka-sdk"',
		'import type { X } from "baka-sdk/sub"',
		'// import { AgentRole } from "baka-sdk"\nconst a = 1',
		'/* import { AgentRole } from "baka-sdk" */\nconst a = 1',
		'const s = "import { A } from baka-sdk"',
		'import { readFileSync } from "node:fs"\nimport type { A } from "baka-sdk"',
	])("accepts %j", (source) => {
		expect(findRuntimeSdkImports(source)).toEqual([])
	})

	it.each([
		['import { AgentRole } from "baka-sdk"', 1],
		['import { AgentRole, type ActionStep } from "baka-sdk"', 1],
		['import * as sdk from "baka-sdk"', 1],
		['import sdk from "baka-sdk"', 1],
		['import sdk, { type A } from "baka-sdk"', 1],
		['import "baka-sdk"', 1],
		['import {} from "baka-sdk"', 1],
		['export { AgentRole } from "baka-sdk"', 1],
		['export * from "baka-sdk"', 1],
		['const sdk = require("baka-sdk")', 1],
		['const sdk = await import("baka-sdk")', 1],
		['import { callLLMAsValidator } from "baka-sdk/validators"', 1],
		['import { readFileSync } from "node:fs"\n\nimport {\n\tAgentRole,\n} from "baka-sdk"', 3],
	])("flags %j at line %i", (source, line) => {
		const findings = findRuntimeSdkImports(source)
		expect(findings).toHaveLength(1)
		expect(findings[0]?.line).toBe(line)
	})
})

describe("findModuleSdkImports", () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
	})

	it("scans module code, skips tests, declaration files, and node_modules", () => {
		const root = mkdtempSync(join(tmpdir(), "baka-sdk-imports-"))
		dirs.push(root)
		const put = (rel: string, content: string) => {
			mkdirSync(join(root, rel, ".."), { recursive: true })
			writeFileSync(join(root, rel), content)
		}
		const bad = 'import { AgentRole } from "baka-sdk"\n'
		put("manifest.ts", 'import type { ModuleManifest } from "baka-sdk"\n')
		put("scaffold/action.ts", bad)
		put("scaffold/validators/check.ts", bad)
		put("_shared/helpers/x.ts", bad)
		put("tests/a.test.ts", bad)
		put("test/b.ts", bad)
		put("scaffold/x.test.ts", bad)
		put("types/baka-sdk.d.ts", bad)
		put("node_modules/pkg/index.ts", bad)
		expect(findModuleSdkImports(root).map((f) => `${f.file}:${f.line}`)).toEqual([
			"_shared/helpers/x.ts:1",
			"scaffold/action.ts:1",
			"scaffold/validators/check.ts:1",
		])
	})
})
