// Black-box discovery-unification tests for the `baka` binary.
//
// Every probe spawns the BUILT artifact (`apps/cli/dist/index.js`) as a
// subprocess with an isolated fake HOME; the user's real ~/.baka is never
// touched.
//
// Coverage map (per `validation-contract.md`):
//
//   VAL-FOUND-025  project-marketplace scope is visible to plan AND validate
//   VAL-FOUND-026  one discovery implementation (no diverged duplicate)
//   VAL-FOUND-054  malformed entries never crash discovery
//   VAL-FOUND-055  same pack in project+user scope dedupes, project wins
//   VAL-FOUND-056  discovery output is deterministic across runs
//   VAL-FOUND-063  cross-pack recipe-id collision refused at plan time
//   VAL-CROSS-001  fresh install discovers bundled packs with zero config
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and helpers (mirrors engine-smoke.test.ts conventions)
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

afterEach(() => {
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
	timeoutMs?: number
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: args.fakeHome,
		XDG_CONFIG_HOME: args.fakeHome,
		XDG_DATA_HOME: args.fakeHome,
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

/** Write a baka config to <home>/.baka/config.json pointing the worker role at the fake LLM. */
function seedWorkerConfig(home: string, baseUrl: string): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify(
			{
				worker: {
					baseUrl,
					model: "fake-llm",
					apiKey: "test-worker-key",
					temperature: 0,
					maxTokens: 8192,
					timeoutMs: 120000,
				},
			},
			null,
			2,
		),
	)
}

// ---------------------------------------------------------------------------
// Fake LLM harness (OpenAI-compatible /chat/completions), scripted responses.
// ---------------------------------------------------------------------------

interface FakeLLMHandle {
	url: string
	close(): Promise<void>
}

const openServers: Server[] = []
afterEach(async () => {
	for (const server of openServers.splice(0)) {
		await new Promise<void>((res) => server.close(() => res()))
	}
})

function startFakeLLM(planContent: string): Promise<FakeLLMHandle> {
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.url !== "/chat/completions" && req.url !== "/v1/chat/completions") {
			res.statusCode = 404
			res.end("not found")
			return
		}
		let body = ""
		req.on("data", (chunk: Buffer) => (body += chunk))
		req.on("end", () => {
			res.setHeader("Content-Type", "application/json")
			res.end(
				JSON.stringify({
					id: "fake-1",
					object: "chat.completion",
					created: 0,
					model: "fake-llm",
					choices: [{ index: 0, message: { role: "assistant", content: planContent }, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			)
		})
	})
	openServers.push(server)
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || !addr) throw new Error("fake LLM: failed to bind")
			resolve({
				url: `http://127.0.0.1:${addr.port}/v1`,
				close: () => new Promise<void>((r) => server.close(() => r())),
			})
		})
	})
}

/** A scripted plan response referencing one pack:recipe step. */
function planReferencing(packName: string, recipeId: string): string {
	return JSON.stringify({
		resolvedSteps: [{ id: "step-1", pack: packName, recipe: recipeId, params: {} }],
	})
}

// ---------------------------------------------------------------------------
// Fixture pack writer
// ---------------------------------------------------------------------------

function writeFixturePack(
	packDir: string,
	name: string,
	opts: { description?: string; version?: string; recipeIds?: string[] } = {},
): void {
	const description = opts.description ?? "fixture"
	const version = opts.version ?? "0.1.0"
	const recipeIds = opts.recipeIds ?? ["act"]
	mkdirSync(packDir, { recursive: true })
	const recipes = recipeIds
		.map(
			(id) =>
				`{ id: "${id}", description: "${id} in ${name}", params: [], requiresReasoning: false, filePatterns: [], validators: [] }`,
		)
		.join(", ")
	writeFileSync(
		join(packDir, "manifest.ts"),
		`import type { PackManifest } from "@repo/protocol"
export const Manifest: PackManifest = {
	name: "${name}",
	version: "${version}",
	description: "${description}",
	dependencies: [],
	conflictsWith: [],
	recipes: [${recipes}],
	packValidators: [],
}
`,
	)
	for (const id of recipeIds) {
		mkdirSync(join(packDir, id), { recursive: true })
		writeFileSync(join(packDir, id, "recipe.ts"), "export const actRecipe = {}\n")
	}
}

function parseJson(stdout: string): Record<string, unknown> {
	try {
		return JSON.parse(stdout) as Record<string, unknown>
	} catch {
		throw new Error(`expected JSON stdout, got:\n${stdout}`)
	}
}

function packNames(listPacksStdout: string): string[] {
	const json = parseJson(listPacksStdout)
	const packs = json.packs as Array<{ name: string }>
	return packs.map((m) => m.name)
}

// ===========================================================================
// VAL-FOUND-026  one discovery implementation (no diverged duplicate)
// ===========================================================================

describe("VAL-FOUND-026 single discovery implementation", () => {
	it("workflows/discovery is gone and no workspace package depends on @repo/discovery-workflow", () => {
		expect(existsSync(join(BAKA_REPO, "workflows", "discovery"))).toBe(false)
		const manifests = [
			join(BAKA_REPO, "apps", "cli", "package.json"),
			join(BAKA_REPO, "apps", "mcp", "package.json"),
			join(BAKA_REPO, "workflows", "feature-planning", "package.json"),
			join(BAKA_REPO, "workflows", "pack-management", "package.json"),
		]
		for (const manifestPath of manifests) {
			const pkg = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
				dependencies?: Record<string, string>
				devDependencies?: Record<string, string>
			}
			expect(
				{ ...pkg.dependencies, ...pkg.devDependencies },
				`${manifestPath} still depends on @repo/discovery-workflow`,
			).not.toHaveProperty("@repo/discovery-workflow")
		}
	})
})

// ===========================================================================
// VAL-CROSS-001  fresh install discovers bundled packs with zero config
// ===========================================================================

describe("discovery has no leaked repo catalog", () => {
	it("lists zero packs from the git checkout", async () => {
		const fakeHome = makeEmptyDir("baka-cross001-home-")
		const { code, stdout, stderr } = await spawnCli({ argv: ["list-packs", "--json"], cwd: BAKA_REPO, fakeHome })
		expect(code, stderr).toBe(0)
		expect(packNames(stdout)).toEqual([])
	})

	it("exits 0 with a no-packs diagnostic from an empty temp dir", async () => {
		const fakeHome = makeEmptyDir("baka-cross001-home-")
		const emptyCwd = makeEmptyDir("baka-cross001-cwd-")
		const { code, stdout, stderr } = await spawnCli({ argv: ["list-packs", "--json"], cwd: emptyCwd, fakeHome })
		expect(code, stderr).toBe(0)
		expect(packNames(stdout)).toEqual([])
		const json = parseJson(stdout)
		const diagnostics = json.diagnostics as Array<{ rule: string; message: string }>
		expect(diagnostics.some((d) => d.rule === "no-packs")).toBe(true)
		expect(stderr).not.toMatch(/at .*\.ts:\d+|\bError\b/)
	})
})

// ===========================================================================
// VAL-FOUND-025  project-marketplace scope visible to plan AND validate
// ===========================================================================

describe("VAL-FOUND-025 project-marketplace scope visibility", () => {
	it("list-packs, validate, and plan all see a project-installed fixture", async () => {
		const fakeHome = makeEmptyDir("baka-f025-home-")
		const project = makeEmptyDir("baka-f025-proj-")
		const fixtureSrc = makeEmptyDir("baka-f025-src-")
		writeFixturePack(join(fixtureSrc, "fx-mod"), "fx-mod", { recipeIds: ["fx-act"] })

		// Install into the project scope (<cwd>/.baka/packs).
		const install = await spawnCli({ argv: ["install", join(fixtureSrc, "fx-mod")], cwd: project, fakeHome })
		expect(install.code, install.stderr).toBe(0)
		expect(existsSync(join(project, ".baka", "packs", "fx-mod"))).toBe(true)

		// (a) list-packs sees it.
		const list = await spawnCli({ argv: ["list-packs", "--json"], cwd: project, fakeHome })
		expect(list.code, list.stderr).toBe(0)
		expect(packNames(list.stdout)).toEqual(["fx-mod"])

		// (b) validate counts it and runs against it.
		const validate = await spawnCli({ argv: ["validate", "--json"], cwd: project, fakeHome })
		expect(validate.code, validate.stderr).toBe(0)
		const validateJson = parseJson(validate.stdout)
		expect(validateJson.packsDiscovered).toBe(1)

		// (c) plan resolves the fixture's recipe via a fake LLM.
		const llm = await startFakeLLM(planReferencing("fx-mod", "fx-act"))
		seedWorkerConfig(fakeHome, llm.url)
		const plan = await spawnCli({ argv: ["plan", "use the fixture", "--json"], cwd: project, fakeHome })
		expect(plan.code, plan.stderr).toBe(0)
		const planJson = parseJson(plan.stdout)
		expect(planJson.status).toBe("SUCCESS")
		const steps = planJson.steps as Array<{ pack: string; recipe: string }>
		expect(steps[0]).toMatchObject({ pack: "fx-mod", recipe: "fx-act" })
	})
})

// ===========================================================================
// VAL-FOUND-054  malformed entries never crash discovery
// ===========================================================================

describe("VAL-FOUND-054 malformed entries tolerated", () => {
	it("broken manifest, dangling symlink, and empty dir are reported, never fatal", async () => {
		const fakeHome = makeEmptyDir("baka-f054-home-")
		const project = makeEmptyDir("baka-f054-proj-")
		const marketDir = join(project, ".baka", "packs")
		mkdirSync(marketDir, { recursive: true })

		// (a) syntactically invalid manifest.ts
		const badSyntax = join(marketDir, "broken-syntax")
		mkdirSync(badSyntax, { recursive: true })
		writeFileSync(join(badSyntax, "manifest.ts"), "export const Manifest = {{{ not valid ts\n")
		// (b) dangling symlink
		symlinkSync(join(marketDir, "no-such-target"), join(marketDir, "dangling-link"))
		// (c) empty directory
		mkdirSync(join(marketDir, "empty-dir"), { recursive: true })
		// (d) one valid fixture
		writeFixturePack(join(marketDir, "good-mod"), "good-mod", { recipeIds: ["good-act"] })

		const list = await spawnCli({ argv: ["list-packs", "--json"], cwd: project, fakeHome })
		expect(list.code, list.stderr).toBe(0)
		expect(list.stderr).not.toMatch(/at .*\.ts:\d+/)
		expect(packNames(list.stdout)).toEqual(["good-mod"])
		const listJson = parseJson(list.stdout)
		const diagnostics = listJson.diagnostics as Array<{ message: string }>
		for (const broken of ["broken-syntax", "dangling-link", "empty-dir"]) {
			expect(
				diagnostics.some((d) => d.message.includes(broken)),
				`expected a diagnostic naming ${broken} in ${JSON.stringify(diagnostics)}`,
			).toBe(true)
		}

		const validate = await spawnCli({ argv: ["validate", "--json"], cwd: project, fakeHome })
		// An unloadable entry is an honest validation failure (exit 4), not a
		// crash: the run must still count the valid fixture and print JSON.
		expect(validate.code === 0 || validate.code === 4, validate.stderr).toBe(true)
		expect(validate.stderr).not.toMatch(/at .*\.ts:\d+/)
		const validateJson = parseJson(validate.stdout)
		expect(validateJson.packsDiscovered).toBe(1)
		const validation = validateJson.validation as { diagnostics: Array<{ message: string }> }
		expect(validation.diagnostics.some((d) => d.message.includes("broken-syntax"))).toBe(true)

		const llm = await startFakeLLM(planReferencing("good-mod", "good-act"))
		seedWorkerConfig(fakeHome, llm.url)
		const plan = await spawnCli({ argv: ["plan", "use the good pack", "--json"], cwd: project, fakeHome })
		expect(plan.code, plan.stderr).toBe(0)
		expect(parseJson(plan.stdout).status).toBe("SUCCESS")
	})
})

// ===========================================================================
// VAL-FOUND-055  project+user dedup, project wins, byte-identical listings
// ===========================================================================

describe("VAL-FOUND-055 project-over-user dedup", () => {
	it("dup-mod appears once with the project copy's metadata on every surface", async () => {
		const fakeHome = makeEmptyDir("baka-f055-home-")
		const project = makeEmptyDir("baka-f055-proj-")
		const src = makeEmptyDir("baka-f055-src-")
		writeFixturePack(join(src, "dup-a", "dup-mod"), "dup-mod", { description: "USER VERSION A", version: "0.1.0" })
		writeFixturePack(join(src, "dup-b", "dup-mod"), "dup-mod", { description: "PROJECT VERSION B", version: "0.2.0" })

		const installUser = await spawnCli({
			argv: ["install", "--user", join(src, "dup-a", "dup-mod")],
			cwd: project,
			fakeHome,
		})
		expect(installUser.code, installUser.stderr).toBe(0)
		expect(existsSync(join(fakeHome, ".baka", "packs", "dup-mod"))).toBe(true)

		const installProject = await spawnCli({ argv: ["install", join(src, "dup-b", "dup-mod")], cwd: project, fakeHome })
		expect(installProject.code, installProject.stderr).toBe(0)

		const first = await spawnCli({ argv: ["list-packs", "--json"], cwd: project, fakeHome })
		const second = await spawnCli({ argv: ["list-packs", "--json"], cwd: project, fakeHome })
		expect(first.code, first.stderr).toBe(0)
		expect(first.stdout).toBe(second.stdout)
		const packs = parseJson(first.stdout).packs as Array<{ name: string; description: string }>
		expect(packs.filter((m) => m.name === "dup-mod")).toHaveLength(1)
		expect(packs[0].description).toBe("PROJECT VERSION B")

		const validate = await spawnCli({ argv: ["validate", "--json"], cwd: project, fakeHome })
		expect(validate.code, validate.stderr).toBe(0)
		expect(parseJson(validate.stdout).packsDiscovered).toBe(1)

		const listRecipes = await spawnCli({
			argv: ["pack", "list-recipes", "dup-mod", "--json"],
			cwd: project,
			fakeHome,
		})
		expect(listRecipes.code, listRecipes.stderr).toBe(0)
		const recipesJson = parseJson(listRecipes.stdout)
		expect(recipesJson.pack).toBe("dup-mod")
		expect(recipesJson.version).toBe("0.2.0")
		expect(recipesJson.description).toBe("PROJECT VERSION B")
	})
})

// ===========================================================================
// VAL-FOUND-056  deterministic discovery output across runs
// ===========================================================================

describe("VAL-FOUND-056 deterministic output", () => {
	it("three list-packs runs are byte-identical with only installed fixtures", async () => {
		const fakeHome = makeEmptyDir("baka-f056-home-")
		const project = makeEmptyDir("baka-f056-proj-")
		writeFileSync(join(project, "package.json"), JSON.stringify({ name: "det-proj", version: "0.0.0" }))
		writeFixturePack(join(project, ".baka", "packs", "zeta-fx"), "zeta-fx")
		writeFixturePack(join(project, ".baka", "packs", "alpha-fx"), "alpha-fx")

		const runs: string[] = []
		for (let i = 0; i < 3; i++) {
			const { code, stdout, stderr } = await spawnCli({ argv: ["list-packs", "--json"], cwd: project, fakeHome })
			expect(code, stderr).toBe(0)
			runs.push(stdout)
		}
		expect(runs[0]).toBe(runs[1])
		expect(runs[1]).toBe(runs[2])
		expect(packNames(runs[0])).toEqual(["alpha-fx", "zeta-fx"])
	})
})

// ===========================================================================
// VAL-FOUND-063  cross-pack recipe-id collision refused at plan time
// ===========================================================================

describe("VAL-FOUND-063 recipe-id collision refusal", () => {
	it("discovery succeeds but a plan referencing the ambiguous recipe id is refused naming both packs", async () => {
		const fakeHome = makeEmptyDir("baka-f063-home-")
		const project = makeEmptyDir("baka-f063-proj-")
		writeFixturePack(join(project, ".baka", "packs", "mod-a"), "mod-a", { recipeIds: ["collide"] })
		writeFixturePack(join(project, ".baka", "packs", "mod-b"), "mod-b", { recipeIds: ["collide"] })

		// Discovery itself succeeds: both packs listed.
		const list = await spawnCli({ argv: ["list-packs", "--json"], cwd: project, fakeHome })
		expect(list.code, list.stderr).toBe(0)
		expect(packNames(list.stdout)).toEqual(["mod-a", "mod-b"])

		// A plan referencing the ambiguous recipe id is refused.
		const llm = await startFakeLLM(planReferencing("mod-a", "collide"))
		seedWorkerConfig(fakeHome, llm.url)
		const plan = await spawnCli({ argv: ["plan", "run the colliding recipe", "--json"], cwd: project, fakeHome })
		expect(plan.code, `expected non-zero exit, got ${plan.code}: ${plan.stdout}`).not.toBe(0)
		const planJson = parseJson(plan.stdout)
		expect(planJson.status).toBe("FAILED")
		const logs = planJson.logs as string[]
		const refusal = logs.find((l) => l.includes("collide") && l.includes("mod-a") && l.includes("mod-b"))
		expect(refusal, `expected a refusal naming both packs in ${JSON.stringify(logs)}`).toBeDefined()
	})
})
