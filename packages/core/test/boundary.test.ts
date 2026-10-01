import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..", "..")

// The provider-sealing grep from docs/PHILOSOPHY.md, applied to the package that
// embedders import: no provider SDK, API host, or agent-engine import may be
// reachable from @baka/core's source or from the workspace packages it bundles.
const PROVIDER_PATTERN =
	/api\.openai|api\.anthropic|@anthropic-ai\/sdk|@earendil-works\/pi-coding-agent|from "openai"|from 'openai'|@repo\/agent-engine/

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) {
			if (name !== "node_modules" && name !== "dist") out.push(...sourceFiles(path))
		} else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
			out.push(path)
		}
	}
	return out
}

describe("provider sealing for @baka/core", () => {
	it.each([
		"packages/core/src",
		"packages/ast-tooling/src",
		"packages/protocol/src",
	])("%s has no provider SDK, API host, or agent-engine import", (dir) => {
		const offenders = sourceFiles(join(REPO, dir)).filter((file) => PROVIDER_PATTERN.test(readFileSync(file, "utf-8")))
		expect(offenders).toEqual([])
	})

	it("does not declare agent-engine as a dependency", () => {
		const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf-8")) as Record<string, unknown>
		expect(JSON.stringify(pkg)).not.toContain("agent-engine")
	})
})
