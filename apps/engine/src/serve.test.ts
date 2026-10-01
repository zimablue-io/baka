import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ENGINE_ALLOWED_ROOTS_ENV, ENGINE_TOKEN_ENV, isLoopbackHost, resolveServeConfig, serveEngine } from "./serve.js"

const cleanup: string[] = []
const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
	for (const server of running.splice(0)) await server.close()
	for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

function project(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-serve-"))
	cleanup.push(dir)
	writeFileSync(join(dir, "package.json"), "{}")
	return dir
}

describe("isLoopbackHost", () => {
	it.each(["127.0.0.1", "127.9.8.7", "localhost", "LOCALHOST", "::1", "[::1]"])("treats %s as loopback", (host) => {
		expect(isLoopbackHost(host)).toBe(true)
	})
	it.each([
		"0.0.0.0",
		"::",
		"192.168.1.20",
		"10.0.0.1",
		"example.com",
		"1270.0.0.1",
		"127.0.0",
		"",
	])("treats %j as reachable from elsewhere", (host) => {
		expect(isLoopbackHost(host)).toBe(false)
	})
})

describe("resolveServeConfig", () => {
	it("defaults to 127.0.0.1:4311 with no token and no extra roots", () => {
		expect(resolveServeConfig({}, {}, "/work")).toEqual({
			port: 4311,
			host: "127.0.0.1",
			token: undefined,
			allowedRoots: [],
		})
	})

	it("refuses a non-loopback bind without a token, and says how to fix it", () => {
		for (const host of ["0.0.0.0", "::", "192.168.1.20"]) {
			expect(() => resolveServeConfig({ host }, {}, "/work")).toThrow(/not a loopback address.*BAKA_ENGINE_TOKEN/)
		}
	})

	it("treats an empty or blank token as no token", () => {
		expect(() => resolveServeConfig({ host: "0.0.0.0", token: "  " }, {}, "/work")).toThrow("loopback")
		expect(() => resolveServeConfig({ host: "0.0.0.0" }, { [ENGINE_TOKEN_ENV]: "" }, "/work")).toThrow("loopback")
	})

	it("accepts a non-loopback bind with a token from the flag or the environment", () => {
		expect(resolveServeConfig({ host: "0.0.0.0", token: "t-flag" }, {}, "/work").token).toBe("t-flag")
		expect(resolveServeConfig({ host: "0.0.0.0" }, { [ENGINE_TOKEN_ENV]: "t-env" }, "/work").token).toBe("t-env")
	})

	it("rejects a token no client could send in an Authorization header", () => {
		expect(() => resolveServeConfig({ token: "two words" }, {}, "/work")).toThrow("whitespace")
	})

	it("lets the flag beat the environment for the token", () => {
		expect(resolveServeConfig({ token: "flag" }, { [ENGINE_TOKEN_ENV]: "env" }, "/work").token).toBe("flag")
	})

	it("combines allowed roots from the environment and flags, resolved against cwd", () => {
		const config = resolveServeConfig(
			{ allowRoots: ["rel/dir", "/abs/two"] },
			{ [ENGINE_ALLOWED_ROOTS_ENV]: ["/abs/one", "", "/abs/env"].join(delimiter) },
			"/work",
		)
		expect(config.allowedRoots).toEqual(["/abs/one", "/abs/env", "/work/rel/dir", "/abs/two"])
	})
})

describe("serveEngine", () => {
	it("serves over real HTTP, enforcing the token", async () => {
		const cwd = project()
		const server = await serveEngine(cwd, { port: 0, host: "127.0.0.1", token: "s3cret-token", allowedRoots: [] })
		running.push(server)
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

		const denied = await fetch(`${server.url}/v1/modules`)
		expect(denied.status).toBe(401)
		const allowed = await fetch(`${server.url}/v1/modules`, { headers: { authorization: "Bearer s3cret-token" } })
		expect(allowed.status).toBe(200)
	})

	it("serves without a token on loopback", async () => {
		const server = await serveEngine(project(), { port: 0, host: "127.0.0.1", allowedRoots: [] })
		running.push(server)
		expect((await fetch(`${server.url}/v1/modules`)).status).toBe(200)
	})
})
