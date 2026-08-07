import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	getActionPreview,
	getCatalog,
	getModuleDetail,
	getPreviewList,
	getVersionDetail,
	RegistryError,
} from "./registry"

interface FetchCall {
	url: string
	init?: RequestInit
}

/**
 * Stubs global `fetch` with a queue of canned responses and returns the
 * captured calls so each test can assert what was requested.
 */
function installFetchStub(responses: Array<Response | (() => Response | Promise<Response>)>): { calls: FetchCall[] } {
	const calls: FetchCall[] = []
	const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		calls.push({ url, init })
		const next = responses.shift()
		if (next === undefined) {
			throw new Error(`fetch stub ran out of responses for ${url}`)
		}
		return typeof next === "function" ? next() : next
	})
	vi.stubGlobal("fetch", stub)
	return { calls }
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
})

describe("resolveBaseUrl", () => {
	beforeEach(() => {
		// The landing app reads VITE_REGISTRY_URL from import.meta.env at
		// module load; the module-level singleton caches the value, so
		// each test imports a fresh copy after stubbing import.meta.env.
		vi.resetModules()
	})

	it("falls back to http://localhost:4300 when no env is set", async () => {
		vi.stubEnv("VITE_REGISTRY_URL", undefined)
		const { resolveBaseUrl: resolve } = await import("./registry")
		expect(resolve()).toBe("http://localhost:4300")
	})

	it("honors VITE_REGISTRY_URL when set to a custom value", async () => {
		vi.stubEnv("VITE_REGISTRY_URL", "http://127.0.0.1:4315")
		const { resolveBaseUrl: resolve } = await import("./registry")
		expect(resolve()).toBe("http://127.0.0.1:4315")
	})

	it("falls back to the default when VITE_REGISTRY_URL is an empty string", async () => {
		vi.stubEnv("VITE_REGISTRY_URL", "")
		const { resolveBaseUrl: resolve } = await import("./registry")
		expect(resolve()).toBe("http://localhost:4300")
	})
})

describe("getCatalog", () => {
	it("returns the parsed modules array from a well-formed response", async () => {
		const { calls } = installFetchStub([
			new Response(
				JSON.stringify({
					modules: [
						{
							scope: "baka",
							name: "baka-base",
							tier: "official",
							visibility: "public",
							description: "Scaffold a TypeScript project.",
							latestVersion: "0.1.0",
							latestStatus: "ready",
						},
						{
							scope: "baka",
							name: "sdd",
							tier: "official",
							visibility: "public",
							description: "Spec-driven development.",
							latestVersion: "0.2.0",
							latestStatus: "ready",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		])
		const result = await getCatalog("http://localhost:4300")
		expect(result).toHaveLength(2)
		expect(result[0]?.name).toBe("baka-base")
		expect(result[1]?.tier).toBe("official")
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toBe("http://localhost:4300/v1/modules")
	})

	it("requests with the explicit baseUrl override when supplied", async () => {
		const { calls } = installFetchStub([
			new Response(JSON.stringify({ modules: [] }), { status: 200, headers: { "content-type": "application/json" } }),
		])
		await getCatalog("http://127.0.0.1:4315")
		expect(calls[0]?.url).toBe("http://127.0.0.1:4315/v1/modules")
	})

	it("raises a RegistryError with the URL when the network call fails", async () => {
		installFetchStub([() => Promise.reject(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:4300"))])
		await expect(getCatalog("http://127.0.0.1:4300")).rejects.toMatchObject({
			name: "RegistryError",
			code: "network",
			url: "http://127.0.0.1:4300/v1/modules",
		})
	})

	it("raises a not-found RegistryError on HTTP 404", async () => {
		installFetchStub([new Response("{}", { status: 404, headers: { "content-type": "application/json" } })])
		await expect(getCatalog("http://localhost:4300")).rejects.toMatchObject({
			name: "RegistryError",
			code: "not-found",
			status: 404,
			url: "http://localhost:4300/v1/modules",
		})
	})

	it("raises an http RegistryError on HTTP 500", async () => {
		installFetchStub([new Response("{}", { status: 500 })])
		await expect(getCatalog("http://localhost:4300")).rejects.toMatchObject({
			name: "RegistryError",
			code: "http",
			status: 500,
		})
	})

	it("raises a parse RegistryError when the response is not valid JSON", async () => {
		installFetchStub([new Response("<html>not json</html>", { status: 200 })])
		await expect(getCatalog("http://localhost:4300")).rejects.toMatchObject({
			name: "RegistryError",
			code: "parse",
		})
	})

	it("raises a parse RegistryError when the JSON body fails the schema", async () => {
		installFetchStub([new Response(JSON.stringify({ modules: "this should be an array" }), { status: 200 })])
		await expect(getCatalog("http://localhost:4300")).rejects.toMatchObject({
			name: "RegistryError",
			code: "parse",
		})
	})

	it("includes the registry URL in every error message so the UI can name it", async () => {
		installFetchStub([() => Promise.reject(new TypeError("connection refused"))])
		try {
			await getCatalog("http://broken.example:9999")
			throw new Error("expected throw")
		} catch (err) {
			expect(err).toBeInstanceOf(RegistryError)
			expect((err as RegistryError).message).toContain("http://broken.example:9999")
		}
	})

	it("returns an empty array when the catalog is genuinely empty", async () => {
		installFetchStub([new Response(JSON.stringify({ modules: [] }), { status: 200 })])
		await expect(getCatalog("http://localhost:4300")).resolves.toEqual([])
	})
})

describe("getModuleDetail", () => {
	it("encodes the scope and name into the path", async () => {
		const { calls } = installFetchStub([
			new Response(
				JSON.stringify({
					scope: "acme",
					name: "weird/name with spaces",
					tier: "community-screened",
					visibility: "public",
					description: "...",
					latestVersion: "1.0.0",
					versions: [{ version: "1.0.0", status: "ready", createdAt: "2026-08-01T00:00:00Z" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		])
		const result = await getModuleDetail("acme", "weird/name with spaces", "http://localhost:4300")
		expect(result.scope).toBe("acme")
		expect(calls[0]?.url).toBe("http://localhost:4300/v1/modules/acme/weird%2Fname%20with%20spaces")
	})

	it("raises a not-found RegistryError on 404", async () => {
		installFetchStub([new Response("{}", { status: 404 })])
		await expect(getModuleDetail("acme", "ghost", "http://localhost:4300")).rejects.toMatchObject({
			name: "RegistryError",
			code: "not-found",
			status: 404,
		})
	})
})

describe("getVersionDetail", () => {
	it("encodes the scope, name, and version into the path", async () => {
		const { calls } = installFetchStub([
			new Response(
				JSON.stringify({
					scope: "baka",
					name: "baka-base",
					tier: "official",
					version: "0.1.0",
					status: "ready",
					commitSha: "0000000000000000000000000000000000000000",
					contentHash: "deadbeef",
					error: null,
					manifest: {
						name: "baka-base",
						version: "0.1.0",
						description: "",
						dependencies: [],
						conflictsWith: [],
						moduleValidators: [],
						actions: [],
					},
					screening: null,
					artifacts: [],
					createdAt: "2026-08-01T00:00:00Z",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		])
		const result = await getVersionDetail("baka", "baka-base", "0.1.0", "http://localhost:4300")
		expect(result.version).toBe("0.1.0")
		expect(calls[0]?.url).toBe("http://localhost:4300/v1/modules/baka/baka-base/0.1.0")
	})
})

describe("getPreviewList", () => {
	it("encodes scope, name, and version into the previews path", async () => {
		const { calls } = installFetchStub([
			new Response(JSON.stringify({ previews: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		])
		await getPreviewList("baka", "baka-base", "0.1.0", "http://localhost:4300")
		expect(calls[0]?.url).toBe("http://localhost:4300/v1/modules/baka/baka-base/0.1.0/previews")
	})

	it("returns the parsed preview entries (rendered + needs-llm)", async () => {
		installFetchStub([
			new Response(
				JSON.stringify({
					previews: [
						{
							actionId: "scaffold",
							state: "rendered",
							files: [{ path: "package.json", size: 42, sha256: "deadbeef" }],
						},
						{ actionId: "init-constitution", state: "needs-llm" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		])
		const result = await getPreviewList("baka", "sdd", "0.1.0", "http://localhost:4300")
		expect(result.previews).toHaveLength(2)
		expect(result.previews[0]?.state).toBe("rendered")
		expect(result.previews[0]?.files?.[0]?.path).toBe("package.json")
		expect(result.previews[1]?.state).toBe("needs-llm")
		expect(result.previews[1]?.files).toBeUndefined()
	})

	it("raises a not-found RegistryError when the version does not exist", async () => {
		installFetchStub([new Response("{}", { status: 404 })])
		await expect(getPreviewList("acme", "ghost", "1.0.0", "http://localhost:4300")).rejects.toMatchObject({
			name: "RegistryError",
			code: "not-found",
		})
	})
})

describe("getActionPreview", () => {
	it("encodes the action id into the previews/:actionId path", async () => {
		const { calls } = installFetchStub([
			new Response(
				JSON.stringify({
					actionId: "scaffold",
					state: "rendered",
					files: [{ path: "package.json", content: "{}", size: 2, sha256: "deadbeef" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		])
		await getActionPreview("baka", "baka-base", "0.1.0", "scaffold", "http://localhost:4300")
		expect(calls[0]?.url).toBe("http://localhost:4300/v1/modules/baka/baka-base/0.1.0/previews/scaffold")
	})

	it("parses the needs-llm state with no files carrier", async () => {
		installFetchStub([
			new Response(
				JSON.stringify({
					actionId: "init-constitution",
					state: "needs-llm",
					reason: "action skipped because it requires LLM reasoning",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		])
		const result = await getActionPreview("baka", "sdd", "0.1.0", "init-constitution", "http://localhost:4300")
		expect(result.state).toBe("needs-llm")
		expect(result.reason).toContain("LLM reasoning")
		expect(result.files).toBeUndefined()
	})

	it("parses the needs-llm state with sentinel-rendered files when present", async () => {
		installFetchStub([
			new Response(
				JSON.stringify({
					actionId: "init-constitution",
					state: "needs-llm",
					reason: "action skipped because it requires LLM reasoning",
					files: [{ path: "specs/mission.md", content: "# Mission\n", size: 11, sha256: "feedface" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		])
		const result = await getActionPreview("baka", "sdd", "0.1.0", "init-constitution", "http://localhost:4300")
		expect(result.state).toBe("needs-llm")
		expect(result.files).toHaveLength(1)
		expect(result.files?.[0]?.path).toBe("specs/mission.md")
	})

	it("raises a not-found RegistryError when the action has no preview record", async () => {
		installFetchStub([
			new Response(JSON.stringify({ error: "no preview record for action 'missing'" }), { status: 404 }),
		])
		await expect(
			getActionPreview("baka", "baka-base", "0.1.0", "missing", "http://localhost:4300"),
		).rejects.toMatchObject({
			name: "RegistryError",
			code: "not-found",
		})
	})
})
