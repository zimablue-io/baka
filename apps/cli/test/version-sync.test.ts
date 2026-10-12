import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const version = (dir: string): string =>
	(JSON.parse(readFileSync(join(root, dir, "package.json"), "utf-8")) as { version: string }).version

// The packages move together: one tag, one version, and the tarballs name each other by it.
describe("published package versions", () => {
	it.each([
		"apps/cli",
		"apps/mcp",
		"packages/core",
		"packages/protocol",
		"packages/sdk",
	])("%s is at the root version", (dir) => {
		expect(version(dir)).toBe(version("."))
	})
})
