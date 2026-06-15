import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	resolveModuleName,
	runMarketplaceAdd,
	runMarketplaceList,
	runMarketplaceRemove,
	runMarketplaceUpdate,
} from "../src/commands/marketplace"

let tmpDir: string
let catalogsPath: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "baka-cli-marketplace-"))
	catalogsPath = join(tmpDir, "catalogs.json")
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

describe("runMarketplaceAdd", () => {
	it("adds a URL and reports it", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		runMarketplaceAdd("https://a.com/c.json", catalogsPath)
		expect(log).toHaveBeenCalledWith("added catalog: https://a.com/c.json")
		log.mockRestore()
	})

	it("is idempotent", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		runMarketplaceAdd("https://a.com/c.json", catalogsPath)
		runMarketplaceAdd("https://a.com/c.json", catalogsPath)
		expect(log).toHaveBeenLastCalledWith("already subscribed: https://a.com/c.json")
		log.mockRestore()
	})
})

describe("runMarketplaceList", () => {
	it("reports empty when nothing is subscribed", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		runMarketplaceList(catalogsPath)
		expect(log).toHaveBeenCalledWith("no subscribed catalogs; use `baka marketplace add <url>`")
		log.mockRestore()
	})

	it("lists subscribed URLs", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		writeFileSync(catalogsPath, JSON.stringify({ catalogs: ["https://a.com", "https://b.com"] }), "utf-8")
		runMarketplaceList(catalogsPath)
		const calls = log.mock.calls.map((c) => c[0]).join("\n")
		expect(calls).toContain("https://a.com")
		expect(calls).toContain("https://b.com")
		log.mockRestore()
	})
})

describe("runMarketplaceRemove", () => {
	it("removes an existing URL", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		runMarketplaceAdd("https://a.com/c.json", catalogsPath)
		runMarketplaceRemove("https://a.com/c.json", catalogsPath)
		expect(log).toHaveBeenLastCalledWith("removed catalog: https://a.com/c.json")
		log.mockRestore()
	})

	it("exits with USER_ERROR when the URL is not subscribed", () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called")
		}) as never)
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		expect(() => runMarketplaceRemove("https://nope.com/c.json", catalogsPath)).toThrow(/process.exit/)
		expect(exitSpy).toHaveBeenCalledWith(1)
		const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(stderr).toContain("not subscribed to")
		exitSpy.mockRestore()
		errSpy.mockRestore()
	})
})

describe("runMarketplaceUpdate", () => {
	it("is a no-op in v1", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		runMarketplaceUpdate()
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/no-op in v1/))
		log.mockRestore()
	})
})

describe("resolveModuleName", () => {
	function makeFetchMock(responses: Record<string, { status: number; body: unknown }>) {
		const fn = async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString()
			const r = responses[url]
			if (!r) return new Response("not found", { status: 404, statusText: "Not Found" })
			return new Response(JSON.stringify(r.body), {
				status: r.status,
				headers: { "content-type": "application/json" },
			})
		}
		return fn
	}

	const builtIn = {
		name: "baka-built-in",
		version: "1.0.0",
		description: "",
		owner: { name: "test" },
		modules: [
			{
				name: "baka-base",
				version: "0.1.0",
				description: "Base module",
				dependencies: [],
				conflictsWith: [],
				actions: [
					{ id: "x", description: "x", params: [], requiresReasoning: false, filePatterns: [], validators: [] },
				],
				moduleValidators: [],
				source: "./modules/baka-base",
				tier: "built-in",
			},
		],
	}

	const verified = { catalogs: [] }

	it("returns null when the API is unreachable", async () => {
		const result = await resolveModuleName("foo", {
			fetch: makeFetchMock({}),
			apiUrl: "https://api.test",
			subscriptions: { catalogs: [] },
		})
		expect(result).toBeNull()
	})

	it("returns the source for a built-in module", async () => {
		const f = makeFetchMock({
			"https://api.test/v1/built-in": { status: 200, body: builtIn },
			"https://api.test/v1/verified": { status: 200, body: verified },
			"https://api.test/v1/modules/baka-base": {
				status: 200,
				body: { module: builtIn.modules[0], source: { catalog: "(built-in)", tier: "built-in" } },
			},
		})
		const result = await resolveModuleName("baka-base", {
			fetch: f,
			apiUrl: "https://api.test",
			subscriptions: { catalogs: [] },
		})
		expect(result).toEqual({ source: "./modules/baka-base", tier: "built-in" })
	})
})
