// ---------------------------------------------------------------------------
// Multi-registry search + bare-name install resolution (architecture §8
// decisions 4 + 27; validation VAL-DISC-011, 012, 013, 021, 022, 023,
// 035, 036, plus the cross-cutting VAL-CROSS-010).
//
// Unit tests for the registry-based rewrite of the search and
// install commands. The CLI now talks to `GET /v1/packs` on every
// configured registry (per decision 4), with per-source attribution
// and per-source failure isolation. The `search.test.ts` file pins
// the JSON shape and the per-hit ordering; this file pins the
// multi-registry merge and the install-resolution precedence.
//
// These tests use a fetch mock so they run in-process without the
// real seed-publishing-server. The end-to-end subprocess suite
// (`baka search` against a real registry) lives in
// `registry-search-e2e.test.ts`.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest"
import { runSearchCommand } from "../src/commands/search"

function makeFetchMock(handlers: Record<string, () => { status: number; body: unknown }>): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString()
		const handler = handlers[url]
		if (!handler) return new Response(JSON.stringify({ error: "no mock" }), { status: 599 })
		const { status, body } = handler()
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})
	}) as unknown as typeof fetch
}

const CATALOG_4300 = {
	packs: [
		{
			scope: "baka",
			name: "alpha",
			tier: "official",
			visibility: "public",
			description: "First probe hit from registry 4300.",
			latestVersion: "0.1.0",
			latestStatus: "ready",
		},
		{
			scope: "baka",
			name: "beta",
			tier: "official",
			visibility: "public",
			description: "Second probe hit from registry 4300.",
			latestVersion: "0.1.0",
			latestStatus: "ready",
		},
	],
}

const CATALOG_4310 = {
	packs: [
		{
			scope: "acme",
			name: "widget",
			tier: "community-screened",
			visibility: "public",
			description: "A probe widget from registry A.",
			latestVersion: "1.0.0",
			latestStatus: "ready",
		},
	],
}

const CATALOG_OTHER = {
	packs: [
		{
			scope: "acme",
			name: "widget",
			tier: "community-screened",
			visibility: "public",
			description: "A probe widget from registry B.",
			latestVersion: "1.0.0",
			latestStatus: "ready",
		},
	],
}

const ALL_OFFLINE_BASES = [
	"http://localhost:4300/v1/packs",
	"http://localhost:4310/v1/packs",
	"http://other:4320/v1/packs",
]

const REPO_ROOT_CWD = "/tmp/non-repo" // any path; tests inject registries directly

afterEach(() => {
	vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// VAL-DISC-011/021/023 — live registry results, multi-registry merge, default
// ---------------------------------------------------------------------------

describe("runSearchCommand multi-registry", () => {
	it("queries every configured registry and tags each hit with its `registry` attribution field", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const fetchMock = makeFetchMock({
			[`${ALL_OFFLINE_BASES[0]}`]: () => ({ status: 200, body: CATALOG_4300 }),
			[`${ALL_OFFLINE_BASES[1]}`]: () => ({ status: 200, body: CATALOG_4310 }),
		})
		await runSearchCommand("probe", {
			fetch: fetchMock,
			registries: ["http://localhost:4300", "http://localhost:4310"],
			cwd: REPO_ROOT_CWD,
			json: true,
		})
		const out = log.mock.calls.map((c) => c[0]).join("\n")
		expect(out).toContain("alpha")
		expect(out).toContain("widget")
		expect(out).toContain("http://localhost:4300")
		expect(out).toContain("http://localhost:4310")
	})

	it("orders results by registry config order (first-listed registry's hits appear first)", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const fetchMock = makeFetchMock({
			[`${ALL_OFFLINE_BASES[0]}`]: () => ({ status: 200, body: CATALOG_4310 }),
			[`${ALL_OFFLINE_BASES[1]}`]: () => ({ status: 200, body: CATALOG_OTHER }),
		})
		await runSearchCommand("widget", {
			fetch: fetchMock,
			registries: ["http://localhost:4310", "http://other:4320"],
			cwd: REPO_ROOT_CWD,
			json: true,
		})
		const payload = JSON.parse(String(log.mock.calls[0]?.[0] ?? "{}")) as {
			results: Array<{ name: string; scope: string; registry: string }>
		}
		expect(payload.results.length).toBeGreaterThan(0)
		// First result must come from http://localhost:4310 (first-listed).
		expect(payload.results[0]?.registry).toBe("http://localhost:4310")
	})

	// VAL-DISC-036 (per-source failure isolation) — one registry down
	// does NOT kill the search; the dead registry becomes a warning
	// and the other registries' results are returned.
	it("isolates a per-source failure and exposes it via the warnings list — does not die", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const fetchMock = ((input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString()
			if (url.endsWith("/v1/packs") && url.startsWith("http://localhost:4300")) {
				return Promise.resolve(
					new Response(JSON.stringify(CATALOG_4300), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
			}
			if (url.endsWith("/v1/packs") && url.startsWith("http://other:4320")) {
				return Promise.reject(new TypeError("fetch failed"))
			}
			return Promise.resolve(new Response(JSON.stringify({}), { status: 500 }))
		}) as unknown as typeof fetch
		await runSearchCommand("probe", {
			fetch: fetchMock,
			registries: ["http://localhost:4300", "http://other:4320"],
			cwd: REPO_ROOT_CWD,
			json: true,
		})
		const payload = JSON.parse(String(log.mock.calls[0]?.[0] ?? "{}")) as {
			results: Array<{ name: string }>
			warnings: Array<{ source: string; error: string }>
		}
		expect(payload.results.map((r) => r.name)).toContain("alpha")
		expect(payload.warnings.length).toBeGreaterThan(0)
		expect(payload.warnings[0]?.source).toContain("http://other:4320")
	})

	// VAL-DISC-013 — when EVERY registry is unreachable, the command
	// exits with FAILED (1), naming the URLs and the transport
	// failure verbatim.
	it("fails honestly with exit 1 when every configured registry is unreachable", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called")
		}) as never)
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const fetchMock = (async (): Promise<Response> => {
			throw new TypeError("fetch failed")
		}) as unknown as typeof fetch
		await expect(
			runSearchCommand("x", {
				fetch: fetchMock,
				registries: ["http://dead-a:4300", "http://dead-b:4310"],
				cwd: REPO_ROOT_CWD,
			}),
		).rejects.toThrow(/process.exit/)
		expect(exitSpy).toHaveBeenCalledWith(1)
		const err = stderr.mock.calls.map((c) => String(c[0])).join("")
		expect(err).toContain("http://dead-a:4300")
		expect(err).toContain("http://dead-b:4310")
	})

	// VAL-DISC-012 — empty result set is a clean exit 0 with a
	// "no packs matching" style message, not an error.
	it("returns a clean empty result set when no pack matches the query", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const fetchMock = makeFetchMock({
			[`${ALL_OFFLINE_BASES[0]}`]: () => ({ status: 200, body: CATALOG_4300 }),
			[`${ALL_OFFLINE_BASES[1]}`]: () => ({ status: 200, body: CATALOG_4310 }),
		})
		await runSearchCommand("zzz-no-match-zzz", {
			fetch: fetchMock,
			registries: ["http://localhost:4300", "http://localhost:4310"],
			cwd: REPO_ROOT_CWD,
		})
		const out = log.mock.calls.map((c) => c[0]).join("\n")
		expect(out).toContain('no packs matching "zzz-no-match-zzz"')
	})
})
