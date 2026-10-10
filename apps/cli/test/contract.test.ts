// The handshake, the health call, the published schemas and the documents real calls return,
// checked against those schemas.

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTRACT_DOCUMENTS, HandshakeSchema, HealthSchema } from "@repo/protocol"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { copyPlatformFixtures } from "./helpers/copy-fixtures"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const CLI_VERSION = (
	JSON.parse(readFileSync(join(BAKA_REPO, "apps", "cli", "package.json"), "utf-8")) as { version: string }
).version

const createdDirs: string[] = []
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	createdDirs.push(dir)
	return dir
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\``)
})

function baka(argv: string[], cwd = tempDir("baka-contract-proj-")) {
	const home = tempDir("baka-contract-home-")
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		const clean = { ...process.env }
		for (const key of Object.keys(clean)) if (key.startsWith("BAKA_")) delete clean[key]
		const child = spawn("node", [DIST_INDEX, ...argv], { cwd, env: { ...clean, HOME: home, XDG_CONFIG_HOME: home } })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (b: Buffer) => {
			stdout += b.toString()
		})
		child.stderr.on("data", (b: Buffer) => {
			stderr += b.toString()
		})
		child.on("close", (code) => resolve({ code, stdout, stderr }))
	})
}

describe("baka version --json is the handshake", () => {
	it("names the tool, its version, the contract it speaks and what it can do", async () => {
		const out = await baka(["version", "--json"])
		expect(out.code, out.stderr).toBe(0)
		const handshake = HandshakeSchema.parse(JSON.parse(out.stdout))
		expect(handshake.version).toBe(CLI_VERSION)
		expect(handshake.contract).toMatch(/^1\.\d+\.\d+$/)
		expect(handshake.capabilities).toEqual(expect.arrayContaining(["recipes.run", "slots.supply", "isolated"]))
	})

	it("prints one readable line without --json", async () => {
		const out = await baka(["version"])
		expect(out.stdout.trim()).toMatch(
			new RegExp(`^baka ${CLI_VERSION.replaceAll(".", "\\.")} \\(contract 1\\.\\d+\\.\\d+\\)$`),
		)
	})

	it("answers the compatibility check: exit 0 when met", async () => {
		const out = await baka([
			"version",
			"--json",
			"--require-contract",
			"1",
			"--require",
			"recipes.run",
			"--require",
			"slots.supply",
		])
		expect(out.code, out.stderr).toBe(0)
	})

	it("answers the compatibility check: exit 3 and the error document when another contract is needed", async () => {
		const out = await baka(["version", "--json", "--require-contract", "2"])
		expect(out.code).toBe(3)
		const body = JSON.parse(out.stdout) as { error: { code: string; message: string; hint: string } }
		expect(body.error.code).toBe("incompatible")
		expect(body.error.hint).toContain("Upgrade baka")
	})

	it("answers the compatibility check: exit 3 naming a capability it lacks", async () => {
		const out = await baka(["version", "--json", "--require", "teleport"])
		expect(out.code).toBe(3)
		expect((JSON.parse(out.stdout) as { error: { message: string } }).error.message).toContain("teleport")
	})

	it("treats a contract major that is not a number as bad input, exit 2", async () => {
		expect((await baka(["version", "--require-contract", "one"])).code).toBe(2)
	})
})

describe("baka health --json", () => {
	it("is ok on a good install, and says what it checked", async () => {
		const out = await baka(["health", "--json"])
		expect(out.code, out.stderr).toBe(0)
		const health = HealthSchema.parse(JSON.parse(out.stdout))
		expect(health.ok).toBe(true)
		expect(health.checks.map((c) => c.name)).toEqual(["node", "starter-pack"])
	})
})

describe("baka schema", () => {
	it("lists the published document ids", async () => {
		const out = await baka(["schema", "--json"])
		expect(out.code, out.stderr).toBe(0)
		const { schemas } = JSON.parse(out.stdout) as { schemas: string[] }
		expect(schemas).toEqual(Object.keys(CONTRACT_DOCUMENTS))
	})

	it("prints the JSON Schema of one document", async () => {
		const out = await baka(["schema", "baka.receipt/1"])
		expect(out.code, out.stderr).toBe(0)
		const schema = JSON.parse(out.stdout) as { title: string; properties: Record<string, unknown> }
		expect(schema.title).toBe("baka.receipt/1")
		expect(Object.keys(schema.properties)).toEqual(
			expect.arrayContaining(["ok", "changeset", "outputTreeHash", "pins", "slots"]),
		)
	})

	it("refuses an unknown id as bad input, naming the known ones", async () => {
		const out = await baka(["schema", "baka.receipt/9", "--json"])
		expect(out.code).toBe(2)
		const body = JSON.parse(out.stdout) as { error: { code: string; hint: string } }
		expect(body.error.code).toBe("unknown-schema")
		expect(body.error.hint).toContain("baka.receipt/1")
	})
})

describe("the documents real calls return are the published ones", () => {
	it("a receipt parses as baka.receipt/1 and carries its schema id", async () => {
		const project = tempDir("baka-contract-run-")
		const out = await baka(["run", "add-readme", "--name", "x", "--json"], project)
		expect(out.code, out.stderr).toBe(0)
		const receipt = JSON.parse(out.stdout)
		expect(receipt.schema).toBe("baka.receipt/1")
		expect(() => CONTRACT_DOCUMENTS["baka.receipt/1"].parse(receipt)).not.toThrow()
		for (const pin of receipt.pins) expect(() => CONTRACT_DOCUMENTS["baka.pin/1"].parse(pin)).not.toThrow()
	})

	it("a failed run's receipt parses too, open slots included", async () => {
		const project = tempDir("baka-contract-open-")
		copyPlatformFixtures(project, ["slot-mod"])
		const out = await baka(["run", "write", "--title", "x", "--json"], project)
		expect(out.code).toBe(1)
		const receipt = CONTRACT_DOCUMENTS["baka.receipt/1"].parse(JSON.parse(out.stdout))
		expect(receipt.ok).toBe(false)
		expect(receipt.openSlots?.map((slot) => slot.id)).toEqual(["line"])
	})

	it("the catalog parses as baka.catalog/1", async () => {
		const out = await baka(["list-packs", "--json"])
		expect(out.code, out.stderr).toBe(0)
		const catalog = JSON.parse(out.stdout)
		expect(catalog.schema).toBe("baka.catalog/1")
		expect(() => CONTRACT_DOCUMENTS["baka.catalog/1"].parse(catalog)).not.toThrow()
	})

	it("the lock file parses as baka.lock/1", async () => {
		const project = tempDir("baka-contract-lock-")
		const out = await baka(["lock", "starter", "--json"], project)
		expect(out.code, out.stderr).toBe(0)
		expect(() =>
			CONTRACT_DOCUMENTS["baka.lock/1"].parse(JSON.parse(readFileSync(join(project, "baka.lock.json"), "utf-8"))),
		).not.toThrow()
	})

	it("an error parses as baka.error/1", async () => {
		const out = await baka(["run", "no-such-recipe", "--json"])
		expect(() => CONTRACT_DOCUMENTS["baka.error/1"].parse(JSON.parse(out.stdout))).not.toThrow()
	})
})
