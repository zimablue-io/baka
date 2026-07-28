import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runSearchCommand } from "../src/commands/search"

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

const baseBuiltIn = {
	name: "baka-built-in",
	version: "1.0.0",
	description: "",
	owner: { name: "test" },
	modules: [
		{
			name: "baka-base",
			version: "0.1.0",
			description: "Base module for any new TypeScript app",
			dependencies: [],
			conflictsWith: [],
			actions: [{ id: "x", description: "x", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
			moduleValidators: [],
			source: "./modules/baka-base",
			tags: ["base", "typescript"],
			tier: "built-in",
		},
		{
			name: "ts-style",
			version: "0.1.0",
			description: "TypeScript style module enforcer",
			dependencies: ["baka-base"],
			conflictsWith: [],
			actions: [{ id: "x", description: "x", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
			moduleValidators: [],
			source: "./modules/ts-style",
			tags: ["linter"],
			tier: "built-in",
		},
	],
}

const verified = { catalogs: [] }

describe("runSearchCommand", () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	})
	afterEach(() => {
		logSpy.mockRestore()
	})

	it("prints matches from the built-in catalog", async () => {
		const f = makeFetchMock({
			"https://api.test/v1/built-in": { status: 200, body: baseBuiltIn },
			"https://api.test/v1/verified": { status: 200, body: verified },
		})
		await runSearchCommand("typescript", {
			fetch: f,
			apiUrl: "https://api.test",
			subscriptions: { catalogs: [] },
		})
		const out = logSpy.mock.calls.map((c) => c[0]).join("\n")
		expect(out).toContain("baka-base")
		expect(out).toContain("ts-style")
		expect(out).toContain('matching "typescript"')
	})

	it("returns nothing when no modules match", async () => {
		const f = makeFetchMock({
			"https://api.test/v1/built-in": { status: 200, body: baseBuiltIn },
			"https://api.test/v1/verified": { status: 200, body: verified },
		})
		await runSearchCommand("zzz-nothing", {
			fetch: f,
			apiUrl: "https://api.test",
			subscriptions: { catalogs: [] },
		})
		const out = logSpy.mock.calls.map((c) => c[0]).join("\n")
		expect(out).toContain('no modules matching "zzz-nothing"')
	})

	it("does not call /v1/aggregate when subscriptions are empty and there are no verified catalogs", async () => {
		const aggregateCalled = vi.fn()
		const f = async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString()
			if (url.endsWith("/v1/aggregate")) {
				aggregateCalled()
				return new Response("{}", { status: 200 })
			}
			if (url.endsWith("/v1/built-in")) {
				return new Response(JSON.stringify(baseBuiltIn), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			}
			if (url.endsWith("/v1/verified")) {
				return new Response(JSON.stringify(verified), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			}
			return new Response("not found", { status: 404 })
		}
		await runSearchCommand("anything", {
			fetch: f as typeof fetch,
			apiUrl: "https://api.test",
			subscriptions: { catalogs: [] },
		})
		expect(aggregateCalled).not.toHaveBeenCalled()
	})

	it("degrades gracefully when the verified endpoint is unreachable", async () => {
		const communityModule = {
			name: "community-foo",
			version: "0.3.0",
			description: "A community module",
			dependencies: [],
			conflictsWith: [],
			actions: [{ id: "x", description: "x", params: [], requiresReasoning: false, filePatterns: [], validators: [] }],
			moduleValidators: [],
			source: "git:github.com/community/foo",
			tags: ["community"],
			tier: "community",
		}
		const f = async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString()
			if (url.endsWith("/v1/built-in")) {
				return new Response(JSON.stringify(baseBuiltIn), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			}
			if (url.endsWith("/v1/verified")) throw new TypeError("fetch failed")
			if (url.endsWith("/v1/aggregate")) {
				return new Response(JSON.stringify({ modules: [communityModule], catalogErrors: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			}
			return new Response("not found", { status: 404 })
		}
		await runSearchCommand("module", {
			fetch: f as typeof fetch,
			apiUrl: "https://api.test",
			subscriptions: { catalogs: ["https://community.example.com/c.json"] },
		})
		const out = logSpy.mock.calls.map((c) => c[0]).join("\n")
		// Partial results still served (exit 0: no process.exit call).
		expect(out).toContain("baka-base")
		expect(out).toContain("community-foo")
		// The failed source is named, not silently dropped.
		expect(out).toContain("https://api.test/v1/verified")
	})

	it("names each dead catalog URL from the aggregate response", async () => {
		const f = makeFetchMock({
			"https://api.test/v1/built-in": { status: 200, body: baseBuiltIn },
			"https://api.test/v1/verified": { status: 200, body: verified },
			"https://api.test/v1/aggregate": {
				status: 200,
				body: {
					modules: [],
					catalogErrors: [{ url: "https://dead.example.com/c.json", error: "connection refused" }],
				},
			},
		})
		await runSearchCommand("typescript", {
			fetch: f,
			apiUrl: "https://api.test",
			subscriptions: { catalogs: ["https://dead.example.com/c.json"] },
		})
		const out = logSpy.mock.calls.map((c) => c[0]).join("\n")
		expect(out).toContain("baka-base")
		expect(out).toContain("https://dead.example.com/c.json")
		expect(out).toContain("connection refused")
	})

	it("fails honestly when every catalog source is unreachable", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called")
		}) as never)
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const f = async (): Promise<Response> => {
			throw new TypeError("fetch failed")
		}
		await expect(
			runSearchCommand("typescript", {
				fetch: f as typeof fetch,
				apiUrl: "https://dead-api.test",
				subscriptions: { catalogs: [] },
			}),
		).rejects.toThrow(/process.exit/)
		expect(exitSpy).toHaveBeenCalledWith(2)
		const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(stderr).toContain("https://dead-api.test")
		expect(stderr).not.toBe("baka: fetch failed\n")
		exitSpy.mockRestore()
		errSpy.mockRestore()
	})

	it("--json emits results and per-source warnings naming the dead URL", async () => {
		const f = makeFetchMock({
			"https://api.test/v1/built-in": { status: 200, body: baseBuiltIn },
			"https://api.test/v1/verified": { status: 200, body: verified },
			"https://api.test/v1/aggregate": {
				status: 200,
				body: {
					modules: [],
					catalogErrors: [{ url: "https://dead.example.com/c.json", error: "connection refused" }],
				},
			},
		})
		await runSearchCommand("typescript", {
			fetch: f,
			apiUrl: "https://api.test",
			subscriptions: { catalogs: ["https://dead.example.com/c.json"] },
			json: true,
		})
		expect(logSpy).toHaveBeenCalledTimes(1)
		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			query: string
			results: Array<{ name: string }>
			warnings: Array<{ source: string; error: string }>
		}
		expect(payload.query).toBe("typescript")
		expect(payload.results.map((r) => r.name)).toContain("baka-base")
		expect(payload.warnings).toEqual([{ source: "https://dead.example.com/c.json", error: "connection refused" }])
	})

	it("merges community modules with the built-in ones", async () => {
		const communityCatalog = {
			name: "community",
			version: "1.0.0",
			description: "",
			owner: { name: "test" },
			modules: [
				{
					name: "community-foo",
					version: "0.3.0",
					description: "A community module",
					dependencies: [],
					conflictsWith: [],
					actions: [
						{ id: "x", description: "x", params: [], requiresReasoning: false, filePatterns: [], validators: [] },
					],
					moduleValidators: [],
					source: "git:github.com/community/foo",
					tags: ["community"],
					tier: "community",
				},
			],
		}
		const f = makeFetchMock({
			"https://api.test/v1/built-in": { status: 200, body: baseBuiltIn },
			"https://api.test/v1/verified": { status: 200, body: verified },
			"https://api.test/v1/aggregate": {
				status: 200,
				body: { modules: communityCatalog.modules, catalogErrors: [] },
			},
		})
		await runSearchCommand("module", {
			fetch: f,
			apiUrl: "https://api.test",
			subscriptions: { catalogs: ["https://community.example.com/c.json"] },
		})
		const out = logSpy.mock.calls.map((c) => c[0]).join("\n")
		expect(out).toContain("baka-base")
		expect(out).toContain("ts-style")
		expect(out).toContain("community-foo")
	})
})
