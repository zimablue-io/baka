// ---------------------------------------------------------------------------
// Integration tests for `apps/mcp` (baka-mcp).
//
// These tests spin up the McpServer in-process and connect an MCP client
// over the SDK's InMemoryTransport. No subprocess, no LLM, no flake.
//
// Coverage:
//   1. tools/list enumerates the four workflow tools + one per declared
//      action across the discovered modules.
//   2. resources/list advertises baka://modules and the
//      baka://module/{name}/manifest template.
//   3. resources/read on baka://modules returns the module directory.
//   4. resources/read on baka://module/baka-base/manifest returns the
//      full manifest JSON.
//   5. tools/call on baka_list_actions returns the parsed actions list.
//   6. tools/call on baka_validate returns a ValidationResult.
//   7. prompts/list returns baka_design_module.
//   8. The grep test from docs/PHILOSOPHY.md still passes after our
//      changes (provider boundary intact).
//   9. Per-action tool baka_baka_base_scaffold exists, has the right
//      inputSchema (Zod-converted), and (if we ran it) would dispatch to
//      the Worker.
//
// We deliberately do NOT test baka_plan / baka_apply here — they need a
// real LLM provider. Those flows are covered end-to-end by the CLI's
// baka-module-create.test.ts against a fake HTTP LLM.
// ---------------------------------------------------------------------------

import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { startServer } from "../src/server.js"

let server: McpServer
let client: Client

const REPO_ROOT = join(__dirname, "..", "..", "..")

beforeAll(async () => {
	// Run against the baka repo itself: it is a valid baka project with
	// several modules under modules/, so we get a realistic tool list.
	server = startServer({ cwd: REPO_ROOT })
	client = new Client({ name: "baka-mcp-test", version: "0.0.0" }, { capabilities: {} })
	const [clientT, serverT] = InMemoryTransport.createLinkedPair()
	await Promise.all([client.connect(clientT), server.connect(serverT)])
})

afterAll(async () => {
	await client.close()
	await server.close()
})

describe("baka-mcp: tools/list", () => {
	test("enumerates the four workflow tools", async () => {
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name)
		expect(names).toContain("baka_plan")
		expect(names).toContain("baka_apply")
		expect(names).toContain("baka_validate")
		expect(names).toContain("baka_list_actions")
	})

	test("enumerates one tool per declared action in the discovered modules", async () => {
		const { tools } = await client.listTools()
		const actionTools = tools.filter((t) => t.name.startsWith("baka_baka_base_"))
		// baka-base has at least: scaffold, add-script, add-dependency
		const ids = actionTools.map((t) => t.name).sort()
		expect(ids).toContain("baka_baka_base_scaffold")
		expect(ids).toContain("baka_baka_base_add_script")
		expect(ids).toContain("baka_baka_base_add_dependency")
	})

	test("per-action tool carries a JSON Schema inputSchema derived from the manifest params", async () => {
		const { tools } = await client.listTools()
		const scaffold = tools.find((t) => t.name === "baka_baka_base_scaffold")
		expect(scaffold).toBeDefined()
		// The schema is in `inputSchema` and should describe the params:
		// name (string, required), description (string, optional),
		// moduleType (string, optional, enum).
		const schema = scaffold?.inputSchema as {
			properties?: Record<string, { type?: string; enum?: string[] }>
			required?: string[]
		}
		expect(schema.properties).toBeDefined()
		expect(schema.properties?.name).toBeDefined()
		expect(schema.properties?.name?.type).toBe("string")
		expect(schema.required).toContain("name")
		expect(schema.properties?.moduleType?.enum).toEqual(["esm", "commonjs"])
	})
})

describe("baka-mcp: resources/list and resources/read", () => {
	test("advertises baka://modules and the module-manifest template", async () => {
		const { resources } = await client.listResources()
		const uris = resources.map((r) => r.uri)
		expect(uris).toContain("baka://modules")
		const { resourceTemplates } = await client.listResourceTemplates()
		const templates = resourceTemplates.map((t) => t.uriTemplate)
		expect(templates).toContain("baka://module/{name}/manifest")
	})

	test("baka://modules returns a directory of all discovered modules", async () => {
		const result = await client.readResource({ uri: "baka://modules" })
		const text = result.contents[0]?.text ?? ""
		const parsed = JSON.parse(text) as { modules: Array<{ name: string; actions: number; uri: string }> }
		expect(Array.isArray(parsed.modules)).toBe(true)
		const base = parsed.modules.find((m) => m.name === "baka-base")
		expect(base).toBeDefined()
		expect(base?.actions).toBeGreaterThan(0)
		expect(base?.uri).toBe("baka://module/baka-base/manifest")
	})

	test("baka://module/baka-base/manifest returns the full manifest", async () => {
		const result = await client.readResource({ uri: "baka://module/baka-base/manifest" })
		const text = result.contents[0]?.text ?? ""
		const manifest = JSON.parse(text) as { name: string; version: string; actions: Array<{ id: string }> }
		expect(manifest.name).toBe("baka-base")
		expect(manifest.actions.length).toBeGreaterThan(0)
		const ids = manifest.actions.map((a) => a.id)
		expect(ids).toContain("scaffold")
	})
})

describe("baka-mcp: tools/call", () => {
	test("baka_list_actions returns the declared actions for a module", async () => {
		const result = await client.callTool({ name: "baka_list_actions", arguments: { module: "baka-base" } })
		const text = (result.content[0] as { type: string; text: string }).text
		const parsed = JSON.parse(text) as {
			module: string
			actions: Array<{ id: string; params: Array<{ name: string; required: boolean }> }>
		}
		expect(parsed.module).toBe("baka-base")
		const scaffold = parsed.actions.find((a) => a.id === "scaffold")
		expect(scaffold).toBeDefined()
		const nameParam = scaffold?.params.find((p) => p.name === "name")
		expect(nameParam?.required).toBe(true)
	})

	test("baka_list_actions throws a structured error for an unknown module", async () => {
		const result = await client.callTool({ name: "baka_list_actions", arguments: { module: "does-not-exist" } })
		expect(result.isError).toBe(true)
		const text = (result.content[0] as { type: string; text: string }).text
		expect(text).toMatch(/module "does-not-exist" not found/)
	})

	test("baka_validate returns a ValidationResult (pass or fail with diagnostics)", async () => {
		const result = await client.callTool({ name: "baka_validate", arguments: {} })
		const text = (result.content[0] as { type: string; text: string }).text
		const parsed = JSON.parse(text) as { modulesDiscovered: number; validation: { kind: "pass" | "fail" } }
		expect(parsed.modulesDiscovered).toBeGreaterThan(0)
		expect(["pass", "fail"]).toContain(parsed.validation.kind)
	})
})

describe("baka-mcp: prompts/list", () => {
	test("advertises baka_design_module", async () => {
		const { prompts } = await client.listPrompts()
		const names = prompts.map((p) => p.name)
		expect(names).toContain("baka_design_module")
	})
})

describe("baka-mcp: provider boundary (grep test from docs/PHILOSOPHY.md)", () => {
	// The provider boundary check from docs/PHILOSOPHY.md is grep-based and
	// flags *any* line matching the pattern, including comments and string
	// literals that mention the pattern. That is a real CI invariant
	// (enforced by `pnpm run check-provider-boundary` at the repo root)
	// but is too noisy for an in-process test. We test the *structural*
	// invariant here instead: the MCP app's source does not import any
	// concrete provider.
	test("MCP source files do not import any concrete LLM provider", async () => {
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
		// Forbidden patterns: a direct import of a concrete provider.
		// Imports from @repo/protocol and @repo/agent-engine are allowed;
		// the latter is the only place concrete providers may live.
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
