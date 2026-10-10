// One Node version for the whole repository: what is tested, deployed and promised must be the same number.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BAKA_NODE_MAJOR } from "@repo/protocol"
import { describe, expect, it } from "vitest"

const repo = join(__dirname, "..", "..", "..")
const read = (file: string) => readFileSync(join(repo, file), "utf-8")

describe("the Node version", () => {
	it("is .nvmrc, which CI and the release workflow read", () => {
		expect(read(".nvmrc").trim()).toBe(String(BAKA_NODE_MAJOR))
		for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
			expect(read(workflow), workflow).toContain("node-version-file: .nvmrc")
			expect(read(workflow), workflow).not.toMatch(/node-version: \d/)
		}
	})

	it("is the engine floor of the repository and of every published package", () => {
		for (const file of [
			"package.json",
			"apps/cli/package.json",
			"apps/mcp/package.json",
			"packages/core/package.json",
		]) {
			const pkg = JSON.parse(read(file)) as { engines?: { node?: string } }
			expect(pkg.engines?.node, file).toBe(`>=${BAKA_NODE_MAJOR}.0.0`)
		}
	})

	it("is what the installer demands and the docs promise", () => {
		const installer = read("install.sh")
		expect(installer).toContain(`-ge ${BAKA_NODE_MAJOR} ]`)
		expect(installer).toContain(`Node.js ${BAKA_NODE_MAJOR} or later`)
		for (const file of ["README.md", "CONTRIBUTING.md", "docs/CONTRACT.md", "packages/core/README.md"]) {
			expect(read(file), file).toMatch(new RegExp(`Node(\\.js)? (v)?${BAKA_NODE_MAJOR}`))
			expect(read(file), file).not.toMatch(/Node(\.js)? (v)?(20|22)\b/)
		}
	})

	it("types the code against the runtime it runs on", () => {
		for (const file of [
			"package.json",
			"apps/cli/package.json",
			"packages/core/package.json",
			"apps/dashboard/package.json",
		]) {
			const pkg = JSON.parse(read(file)) as { devDependencies?: Record<string, string> }
			expect(pkg.devDependencies?.["@types/node"], file).toBe(`^${BAKA_NODE_MAJOR}.0.0`)
		}
	})
})
