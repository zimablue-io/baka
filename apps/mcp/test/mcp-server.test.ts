// MCP server against project-local fixture modules (honest-mod, slot-mod).
// No shipped catalog. No per-action tools.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { copyPlatformFixtures } from "../../cli/test/helpers/copy-fixtures"
import { startServer } from "../src/server.js"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

let server: McpServer
let client: Client
let fixtureCwd: string

beforeAll(async () => {
	fixtureCwd = mkdtempSync(join(tmpdir(), "baka-mcp-server-fx-"))
	copyPlatformFixtures(fixtureCwd)
	server = startServer({ cwd: fixtureCwd })
	client = new Client({ name: "baka-mcp-test", version: "0.0.0" }, { capabilities: {} })
	const [clientT, serverT] = InMemoryTransport.createLinkedPair()
	await Promise.all([client.connect(clientT), server.connect(serverT)])
})

afterAll(async () => {
	await client.close()
	await server.close()
	rmSync(fixtureCwd, { recursive: true, force: true })
})

describe("baka-mcp: tools/list", () => {
	test("enumerates engine tools", async () => {
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name)
		expect(names).toContain("baka_plan")
		expect(names).toContain("baka_apply")
		expect(names).toContain("baka_validate")
		expect(names).toContain("baka_list_actions")
		expect(names).toContain("baka_run")
		expect(names).toContain("baka_slots")
		expect(names).toContain("baka_fill")
	})

	test("does not expose per-action tools", async () => {
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name)
		expect(names.filter((n) => n.startsWith("baka_honest_mod_"))).toEqual([])
		expect(names.filter((n) => n.startsWith("baka_slot_mod_"))).toEqual([])
		expect(names).not.toContain("baka_install")
	})
})

describe("baka-mcp: resources", () => {
	test("advertises baka://modules and the module-manifest template", async () => {
		const { resources } = await client.listResources()
		expect(resources.map((r) => r.uri)).toContain("baka://modules")
		const { resourceTemplates } = await client.listResourceTemplates()
		expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("baka://module/{name}/manifest")
	})

	test("baka://modules lists the fixture modules", async () => {
		const result = await client.readResource({ uri: "baka://modules" })
		const parsed = JSON.parse(result.contents[0]?.text ?? "") as {
			modules: Array<{ name: string; actions: number; uri: string }>
		}
		const listed = parsed.modules.find((m) => m.name === "honest-mod")
		expect(listed?.actions).toBeGreaterThan(0)
		expect(listed?.uri).toBe("baka://module/honest-mod/manifest")
	})

	test("baka://module/honest-mod/manifest returns the write action", async () => {
		const result = await client.readResource({ uri: "baka://module/honest-mod/manifest" })
		const manifest = JSON.parse(result.contents[0]?.text ?? "") as {
			name: string
			actions: Array<{ id: string }>
		}
		expect(manifest.name).toBe("honest-mod")
		expect(manifest.actions.map((a) => a.id)).toContain("write")
	})
})

describe("baka-mcp: tools/call", () => {
	test("baka_list_actions returns honest-mod/write", async () => {
		const result = await client.callTool({ name: "baka_list_actions", arguments: { module: "honest-mod" } })
		const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
			module: string
			actions: Array<{ id: string }>
		}
		expect(parsed.module).toBe("honest-mod")
		expect(parsed.actions.some((a) => a.id === "write")).toBe(true)
	})

	test("baka_list_actions is an error for an unknown module", async () => {
		const result = await client.callTool({ name: "baka_list_actions", arguments: { module: "does-not-exist" } })
		expect(result.isError).toBe(true)
		expect((result.content[0] as { text: string }).text).toMatch(/module "does-not-exist" not found/)
	})

	test("baka_validate returns a pass/fail payload", async () => {
		const result = await client.callTool({ name: "baka_validate", arguments: {} })
		const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
			modulesDiscovered: number
			validation: { kind: "pass" | "fail" }
		}
		expect(parsed.modulesDiscovered).toBeGreaterThan(0)
		expect(["pass", "fail"]).toContain(parsed.validation.kind)
	})
})

describe("baka-mcp: prompts/list", () => {
	test("advertises baka_design_module", async () => {
		const { prompts } = await client.listPrompts()
		expect(prompts.map((p) => p.name)).toContain("baka_design_module")
	})
})

describe("baka-mcp: provider boundary", () => {
	test("MCP source files do not import a concrete LLM provider", async () => {
		const fs = await import("node:fs/promises")
		const path = await import("node:path")
		const filesToCheck: string[] = []
		const root = path.join(REPO_ROOT, "apps", "mcp", "src")
		async function walk(dir: string) {
			const entries = await fs.readdir(dir, { withFileTypes: true })
			for (const e of entries) {
				const p = path.join(dir, e.name)
				if (e.isDirectory()) await walk(p)
				else if (e.name.endsWith(".ts")) filesToCheck.push(p)
			}
		}
		await walk(root)
		const offenders: string[] = []
		const forbidden = [
			/from\s+["']openai["']/,
			/from\s+["']@anthropic-ai\/sdk["']/,
			/from\s+["']@google\/generative-ai["']/,
			/from\s+["']ollama["']/,
		]
		for (const file of filesToCheck) {
			const content = await fs.readFile(file, "utf-8")
			for (const pat of forbidden) {
				if (pat.test(content)) {
					offenders.push(`${path.relative(REPO_ROOT, file)}: matches ${pat}`)
				}
			}
		}
		expect(offenders).toEqual([])
	})
})
