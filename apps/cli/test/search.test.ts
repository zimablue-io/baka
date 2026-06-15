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
