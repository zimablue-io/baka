// The MCP server resolves a project's modules the way the CLI does: BAKA_MODULE_DIRS, then
// `.baka/settings.json` `moduleDirs`, else the default discovery.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, test, vi } from "vitest"

const FIXTURES = join(__dirname, "..", "..", "cli", "test", "fixtures")

const created: string[] = []
const priorHome = process.env.BAKA_HOME
const priorDirs = process.env.BAKA_MODULE_DIRS
afterEach(() => {
	if (priorHome === undefined) delete process.env.BAKA_HOME
	else process.env.BAKA_HOME = priorHome
	if (priorDirs === undefined) delete process.env.BAKA_MODULE_DIRS
	else process.env.BAKA_MODULE_DIRS = priorDirs
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	created.push(dir)
	return dir
}

/** A project whose settings list `../catalog` (holding honest-mod), and a stray slot-mod in the user marketplace. */
function projectWithCatalog(moduleDirs: string[]): string {
	const parent = tmp("baka-mcp-settings-")
	const project = join(parent, "project")
	mkdirSync(join(project, ".baka"), { recursive: true })
	mkdirSync(join(parent, "catalog"))
	cpSync(join(FIXTURES, "honest-mod"), join(parent, "catalog", "honest-mod"), { recursive: true })
	writeFileSync(join(project, ".baka", "settings.json"), JSON.stringify({ moduleDirs }))
	const home = tmp("baka-mcp-settings-home-")
	mkdirSync(join(home, "modules"))
	cpSync(join(FIXTURES, "slot-mod"), join(home, "modules", "slot-mod"), { recursive: true })
	process.env.BAKA_HOME = home
	delete process.env.BAKA_MODULE_DIRS
	return project
}

/** The server keeps its initialize guard in module state, so each server gets a fresh copy of the module. */
async function freshStartServer(): Promise<typeof import("../src/server.js").startServer> {
	vi.resetModules()
	return (await import("../src/server.js")).startServer
}

async function listedModules(project: string): Promise<string[]> {
	const startServer = await freshStartServer()
	const server = startServer({ cwd: project })
	const client = new Client({ name: "baka-mcp-test", version: "0.0.0" }, { capabilities: {} })
	const [clientT, serverT] = InMemoryTransport.createLinkedPair()
	await Promise.all([client.connect(clientT), server.connect(serverT)])
	try {
		const res = await client.readResource({ uri: "baka://modules" })
		const first = res.contents[0]
		const text = first && "text" in first ? first.text : "{}"
		return (JSON.parse(text) as { modules: Array<{ name: string }> }).modules.map((m) => m.name)
	} finally {
		await client.close()
		await server.close()
	}
}

describe("baka-mcp: .baka/settings.json moduleDirs", () => {
	test("is the whole module scope: the stray user-marketplace module is not served", async () => {
		expect(await listedModules(projectWithCatalog(["../catalog"]))).toEqual(["honest-mod"])
	})

	test("BAKA_MODULE_DIRS beats the settings", async () => {
		const project = projectWithCatalog(["../catalog"])
		process.env.BAKA_MODULE_DIRS = tmp("baka-mcp-settings-env-")
		expect(await listedModules(project)).toEqual([])
	})

	test("a listed directory that does not exist stops startup with the file, the entry and the fix", async () => {
		const project = projectWithCatalog(["../gone"])
		const startServer = await freshStartServer()
		expect(() => startServer({ cwd: project })).toThrow(
			/settings\.json: moduleDirs\[0\] is "\.\.\/gone".*create the directory/s,
		)
	})
})
