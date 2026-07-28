// Black-box marketplace/search honesty tests for the `baka` binary.
//
// Every probe spawns the BUILT artifact (`apps/cli/dist/index.js`) as a
// subprocess with an isolated fake HOME; the user's real ~/.baka is never
// touched. The marketplace API is the REAL `@baka/api` Hono app served
// over real HTTP (node:http bridge to app.fetch), so the search/install
// paths exercise the genuine /v1/built-in, /v1/verified, /v1/aggregate,
// and /v1/modules/:name routes.
//
// Coverage map (per `validation-contract.md`):
//
//   VAL-FOUND-037  search degrades gracefully when one catalog is unreachable
//   VAL-FOUND-038  search with ALL sources unreachable fails honestly
//   VAL-FOUND-039  install <bare-name> reports truthful failure modes
//   VAL-FOUND-040  installing a module makes it visible to list/validate/list-actions
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import apiApp from "@baka/api"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and helpers (mirrors discovery-smoke.test.ts conventions)
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

function makeEmptyDir(prefix: string): string {
	return trackDir(mkdtempSync(join(tmpdir(), prefix)))
}

const openServers: Server[] = []
function trackServer(server: Server): Server {
	openServers.push(server)
	return server
}

afterEach(async () => {
	for (const server of openServers.splice(0)) {
		await new Promise<void>((res) => server.close(() => res()))
	}
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
})

/** Spawn the built CLI with an isolated HOME and resolve stdout/stderr/code. */
function spawnCli(args: {
	argv: string[]
	cwd: string
	fakeHome: string
	env?: Record<string, string>
	timeoutMs?: number
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: args.fakeHome,
		XDG_CONFIG_HOME: args.fakeHome,
		XDG_DATA_HOME: args.fakeHome,
		...args.env,
	}
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...args.argv], { cwd: args.cwd, env })
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve({ code: null, stdout, stderr: `${stderr}\n[test: killed after ${args.timeoutMs ?? 30_000}ms timeout]` })
		}, args.timeoutMs ?? 30_000)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

function parseJson(stdout: string): Record<string, unknown> {
	try {
		return JSON.parse(stdout) as Record<string, unknown>
	} catch {
		throw new Error(`expected JSON stdout, got:\n${stdout}`)
	}
}

// ---------------------------------------------------------------------------
// HTTP fixtures
// ---------------------------------------------------------------------------

interface ServedHandle {
	url: string
}

function listen(server: Server): Promise<ServedHandle> {
	trackServer(server)
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || !addr) {
				reject(new Error("failed to bind"))
				return
			}
			resolve({ url: `http://127.0.0.1:${addr.port}` })
		})
	})
}

/** Serve the real @baka/api Hono app over node:http on an ephemeral port. */
function serveMarketplaceApi(): Promise<ServedHandle> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			void (async () => {
				const body = Buffer.concat(chunks)
				const headers: Record<string, string> = {}
				const contentType = req.headers["content-type"]
				if (typeof contentType === "string") headers["content-type"] = contentType
				const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
					method: req.method ?? "GET",
					headers,
					body: body.length > 0 ? body : undefined,
				})
				const response = await apiApp.fetch(request)
				res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
				res.end(Buffer.from(await response.arrayBuffer()))
			})().catch((err) => {
				res.writeHead(500)
				res.end(String(err))
			})
		})
	})
	return listen(server)
}

/** Serve one static JSON document (a community catalog) on an ephemeral port. */
function serveJson(document: unknown): Promise<ServedHandle> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(document))
	})
	return listen(server)
}

/** A port that accepts nothing: bound, then immediately closed. */
function deadPort(): Promise<number> {
	const server = createServer()
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || !addr) {
				reject(new Error("failed to bind"))
				return
			}
			const port = addr.port
			server.close(() => resolve(port))
		})
	})
}

// ---------------------------------------------------------------------------
// Catalog / module fixtures
// ---------------------------------------------------------------------------

/** A valid community catalog carrying the marker module. */
function markerCatalog(source: string): unknown {
	return {
		name: "marker-catalog",
		version: "1.0.0",
		description: "test catalog",
		owner: { name: "Tester" },
		modules: [
			{
				name: "marker-mod",
				version: "0.1.0",
				description: "Marker typescript fixture module",
				dependencies: [],
				conflictsWith: [],
				actions: [
					{
						id: "mark",
						description: "writes marker.txt",
						params: [],
						requiresReasoning: false,
						filePatterns: ["marker.txt"],
						validators: [],
					},
				],
				moduleValidators: [],
				source,
				tags: ["typescript", "marker"],
			},
		],
	}
}

/** A loadable on-disk fixture module (same shape as discovery-smoke fixtures). */
function writeFixtureModule(moduleDir: string, name: string): void {
	mkdirSync(moduleDir, { recursive: true })
	writeFileSync(
		join(moduleDir, "manifest.ts"),
		`import type { ModuleManifest } from "@repo/protocol"
export const Manifest: ModuleManifest = {
	name: "${name}",
	version: "0.1.0",
	description: "Marker typescript fixture module",
	dependencies: [],
	conflictsWith: [],
	actions: [{ id: "mark", description: "writes marker.txt", params: [], requiresReasoning: false, filePatterns: ["marker.txt"], validators: [] }],
	moduleValidators: [],
}
`,
	)
	mkdirSync(join(moduleDir, "mark"), { recursive: true })
	writeFileSync(join(moduleDir, "mark", "action.ts"), "export const markAction = {}\n")
}

// ===========================================================================
// VAL-FOUND-037  one unreachable catalog: partial results + named warning
// ===========================================================================

describe("VAL-FOUND-037 search degrades gracefully when one catalog is unreachable", () => {
	it("exit 0, marker module in results, per-source warning names the dead URL", async () => {
		const fakeHome = makeEmptyDir("baka-f037-home-")
		const cwd = makeEmptyDir("baka-f037-cwd-")
		const api = await serveMarketplaceApi()
		const stub = await serveJson(markerCatalog("git:github.com/test/marker-mod"))
		const dead = await deadPort()
		const deadUrl = `http://127.0.0.1:${dead}/catalog.json`
		const env = { BAKA_API_URL: api.url }

		const addLive = await spawnCli({
			argv: ["marketplace", "add", `${stub.url}/catalog.json`],
			cwd,
			fakeHome,
			env,
		})
		expect(addLive.code, addLive.stderr).toBe(0)
		const addDead = await spawnCli({ argv: ["marketplace", "add", deadUrl], cwd, fakeHome, env })
		expect(addDead.code, addDead.stderr).toBe(0)

		const search = await spawnCli({ argv: ["search", "typescript", "--json"], cwd, fakeHome, env })
		expect(search.code, `search exited ${search.code}; stderr=${search.stderr}`).toBe(0)
		const payload = parseJson(search.stdout) as {
			results: Array<{ name: string }>
			warnings: Array<{ source: string; error: string }>
		}
		expect(payload.results.map((r) => r.name)).toContain("marker-mod")
		expect(payload.warnings.map((w) => w.source)).toContain(deadUrl)
	})
})

// ===========================================================================
// VAL-FOUND-038  ALL sources unreachable: honest non-zero exit
// ===========================================================================

describe("VAL-FOUND-038 search with all sources unreachable fails honestly", () => {
	it("exit non-zero, names the unreachable base URL, no bare fetch failure", async () => {
		const fakeHome = makeEmptyDir("baka-f038-home-")
		const cwd = makeEmptyDir("baka-f038-cwd-")
		const deadApiPort = await deadPort()
		const deadApi = `http://127.0.0.1:${deadApiPort}`
		const deadCatalogPort = await deadPort()
		const env = { BAKA_API_URL: deadApi }

		// Register a subscription so the aggregate path is also exercised.
		const add = await spawnCli({
			argv: ["marketplace", "add", `http://127.0.0.1:${deadCatalogPort}/catalog.json`],
			cwd,
			fakeHome,
			env,
		})
		expect(add.code, add.stderr).toBe(0)

		const search = await spawnCli({ argv: ["search", "typescript", "--json"], cwd, fakeHome, env })
		expect(search.code, `search unexpectedly succeeded: ${search.stdout}`).not.toBe(0)
		expect(search.stderr).toContain(deadApi)
		expect(search.stderr).not.toBe("baka: fetch failed\n")
		// A connectivity failure must not masquerade as an empty result set.
		expect(search.stdout).not.toContain("no modules matching")
	})
})

// ===========================================================================
// VAL-FOUND-039  install <bare-name> truthful failure modes
// ===========================================================================

describe("VAL-FOUND-039 install <bare-name> reports truthful failure modes", () => {
	it("unreachable registry: transport truth, not a parse error", async () => {
		const fakeHome = makeEmptyDir("baka-f039-home-")
		const cwd = makeEmptyDir("baka-f039-cwd-")
		const deadApiPort = await deadPort()
		const deadApi = `http://127.0.0.1:${deadApiPort}`

		const install = await spawnCli({
			argv: ["install", "ts-style"],
			cwd,
			fakeHome,
			env: { BAKA_API_URL: deadApi },
		})
		expect(install.code, `install unexpectedly succeeded: ${install.stdout}`).not.toBe(0)
		expect(install.stderr).toContain(deadApi)
		expect(install.stderr).not.toContain("unrecognized source")
	})

	it("reachable registry without the module: not-found truth", async () => {
		const fakeHome = makeEmptyDir("baka-f039b-home-")
		const cwd = makeEmptyDir("baka-f039b-cwd-")
		const api = await serveMarketplaceApi()

		const install = await spawnCli({
			argv: ["install", "ghost-module"],
			cwd,
			fakeHome,
			env: { BAKA_API_URL: api.url },
		})
		expect(install.code, `install unexpectedly succeeded: ${install.stdout}`).not.toBe(0)
		expect(install.stderr).toContain("not found in the registry")
		expect(install.stderr).toContain("ghost-module")
		expect(install.stderr).not.toContain("unrecognized source")
	})

	it("unreachable and not-found are distinguishable by exit code", async () => {
		const fakeHome = makeEmptyDir("baka-f039c-home-")
		const cwd = makeEmptyDir("baka-f039c-cwd-")
		const deadApiPort = await deadPort()
		const api = await serveMarketplaceApi()

		const unreachable = await spawnCli({
			argv: ["install", "ts-style"],
			cwd,
			fakeHome,
			env: { BAKA_API_URL: `http://127.0.0.1:${deadApiPort}` },
		})
		const notFound = await spawnCli({
			argv: ["install", "ghost-module"],
			cwd,
			fakeHome,
			env: { BAKA_API_URL: api.url },
		})
		expect(unreachable.code).not.toBe(0)
		expect(notFound.code).not.toBe(0)
		expect(unreachable.code).not.toBe(notFound.code)
	})
})

// ===========================================================================
// VAL-FOUND-040  install via the marketplace makes the module visible to
// list-modules, validate, and list-actions alike
// ===========================================================================

describe("VAL-FOUND-040 install visibility across surfaces", () => {
	it("bare-name install from a stub catalog is visible to list/validate/list-actions", async () => {
		const fakeHome = makeEmptyDir("baka-f040-home-")
		const project = makeEmptyDir("baka-f040-proj-")
		const fixtureSrc = makeEmptyDir("baka-f040-src-")
		writeFixtureModule(join(fixtureSrc, "marker-mod"), "marker-mod")

		const api = await serveMarketplaceApi()
		const catalog = await serveJson(markerCatalog(join(fixtureSrc, "marker-mod")))
		const env = { BAKA_API_URL: api.url }

		const add = await spawnCli({
			argv: ["marketplace", "add", `${catalog.url}/catalog.json`],
			cwd: project,
			fakeHome,
			env,
		})
		expect(add.code, add.stderr).toBe(0)

		const install = await spawnCli({ argv: ["install", "marker-mod"], cwd: project, fakeHome, env })
		expect(install.code, `install failed: ${install.stderr}`).toBe(0)
		expect(existsSync(join(project, ".baka", "modules", "marker-mod"))).toBe(true)

		// The settings entry records the resolved source.
		const settings = JSON.parse(readFileSync(join(project, ".baka", "settings.json"), "utf-8")) as {
			packages: string[]
		}
		expect(settings.packages).toEqual([join(fixtureSrc, "marker-mod")])

		// (a) list-modules sees it.
		const list = await spawnCli({ argv: ["list-modules", "--json"], cwd: project, fakeHome })
		expect(list.code, list.stderr).toBe(0)
		const listJson = parseJson(list.stdout) as { modules: Array<{ name: string }> }
		expect(listJson.modules.map((m) => m.name)).toContain("marker-mod")

		// (b) validate counts it.
		const validate = await spawnCli({ argv: ["validate", "--json"], cwd: project, fakeHome })
		expect(validate.code, validate.stderr).toBe(0)
		const validateJson = parseJson(validate.stdout) as { modulesDiscovered: number }
		expect(validateJson.modulesDiscovered).toBe(1)

		// (c) its actions are enumerable.
		const actions = await spawnCli({
			argv: ["module", "list-actions", "marker-mod", "--json"],
			cwd: project,
			fakeHome,
		})
		expect(actions.code, actions.stderr).toBe(0)
		const actionsJson = parseJson(actions.stdout) as { actions: Array<{ id: string }> }
		expect(actionsJson.actions.map((a) => a.id)).toEqual(["mark"])
	})
})
