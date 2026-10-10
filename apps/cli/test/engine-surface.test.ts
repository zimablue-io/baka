// Engine CLI surface against project-local fixture packs.
// The production catalog is empty. Nothing here assumes a shipped pack.

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { copyPlatformFixtures } from "./helpers/copy-fixtures"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const EMPTY_CWD = join(tmpdir(), "baka-engine-surface-empty")

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

function makeEmptyDir(prefix: string): string {
	return trackDir(mkdtempSync(join(tmpdir(), prefix)))
}

function fixtureProject(prefix: string): string {
	const dir = makeEmptyDir(prefix)
	copyPlatformFixtures(dir)
	return dir
}

function seedRoleConfig(
	home: string,
	cfg: {
		worker?: { baseUrl: string; model: string; apiKey?: string }
		validator?: { baseUrl: string; model: string; apiKey?: string }
	},
): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	const out: Record<string, unknown> = {}
	if (cfg.worker) {
		out.worker = {
			baseUrl: cfg.worker.baseUrl,
			model: cfg.worker.model,
			apiKey: cfg.worker.apiKey ?? "test-worker-key",
			temperature: 0,
			maxTokens: 8192,
			timeoutMs: 120000,
		}
	}
	if (cfg.validator) {
		out.validator = {
			baseUrl: cfg.validator.baseUrl,
			model: cfg.validator.model,
			apiKey: cfg.validator.apiKey ?? "test-validator-key",
			temperature: 0,
			maxTokens: 8192,
			timeoutMs: 120000,
		}
	}
	writeFileSync(join(dir, "config.json"), JSON.stringify(out, null, 2))
}

function spawnCli(args: {
	argv: string[]
	cwd?: string
	env?: Record<string, string>
	bakaConfig?: {
		worker?: { baseUrl: string; model: string; apiKey?: string }
		validator?: { baseUrl: string; model: string; apiKey?: string }
	}
	timeoutMs?: number
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	let env: NodeJS.ProcessEnv = { ...process.env, ...args.env }
	if (args.bakaConfig) {
		const fakeHome = mkdtempSync(join(tmpdir(), "baka-cli-cfg-"))
		createdDirs.push(fakeHome)
		seedRoleConfig(fakeHome, args.bakaConfig)
		env = { ...env, HOME: fakeHome, XDG_CONFIG_HOME: fakeHome, XDG_DATA_HOME: fakeHome }
	}
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...args.argv], {
			cwd: args.cwd ?? BAKA_REPO,
			env,
		})
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => {
			stdout += b.toString()
		})
		child.stderr?.on("data", (b: Buffer) => {
			stderr += b.toString()
		})
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

interface FakeLLMHandle {
	url: string
	calls: number
	close(): Promise<void>
}

function startFakeLLM(content: string): Promise<FakeLLMHandle> {
	let calls = 0
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.url !== "/chat/completions" && req.url !== "/v1/chat/completions") {
			res.statusCode = 404
			res.end("not found")
			return
		}
		req.on("data", () => {})
		req.on("end", () => {
			calls++
			res.setHeader("Content-Type", "application/json")
			res.end(
				JSON.stringify({
					id: `fake-${calls}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: "fake-llm",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			)
		})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || !addr) throw new Error("fake LLM: failed to bind")
			resolve({
				url: `http://127.0.0.1:${addr.port}/v1`,
				get calls() {
					return calls
				},
				close: () => new Promise<void>((res) => server.close(() => res())),
			})
		})
	})
}

function countBakaTestDirs(): number {
	return readdirSync(tmpdir()).filter((e) => {
		if (!e.startsWith("baka-test-")) return false
		try {
			return statSync(join(tmpdir(), e)).isDirectory()
		} catch {
			return false
		}
	}).length
}

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	if (!existsSync(EMPTY_CWD)) mkdirSync(EMPTY_CWD, { recursive: true })
})

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

afterAll(() => {
	if (existsSync(EMPTY_CWD)) rmSync(EMPTY_CWD, { recursive: true, force: true })
})

describe("pack create rejects a bad name without calling an LLM", () => {
	it("exits 1 with no stack frames", async () => {
		const llm = await startFakeLLM("{}")
		try {
			const { code, stderr } = await spawnCli({
				argv: ["pack", "create", "../../../etc/passwd"],
				bakaConfig: { worker: { baseUrl: llm.url, model: "fake-llm" } },
			})
			expect(code).toBe(1)
			expect(stderr).toContain("pack name must be")
			expect(llm.calls).toBe(0)
			expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		} finally {
			await llm.close()
		}
	})
})

describe("pack validate / list-recipes / test against a fixture", () => {
	it("validates honest-mod", async () => {
		const cwd = fixtureProject("baka-mod-validate-")
		const { code, stdout, stderr } = await spawnCli({
			argv: ["pack", "validate", "honest-mod", "--json"],
			cwd,
		})
		expect(code, stderr).toBe(0)
		const parsed = JSON.parse(stdout) as { pack: string; valid: boolean; errors: string[] }
		expect(parsed.pack).toBe("honest-mod")
		expect(parsed.valid).toBe(true)
		expect(parsed.errors).toEqual([])
	})

	it("lists slot-mod recipes and params from the manifest", async () => {
		const cwd = fixtureProject("baka-mod-recipes-")
		const { code, stdout, stderr } = await spawnCli({
			argv: ["pack", "list-recipes", "slot-mod", "--json"],
			cwd,
		})
		expect(code, stderr).toBe(0)
		const parsed = JSON.parse(stdout) as { pack: string; recipes: Array<{ id: string }> }
		expect(parsed.pack).toBe("slot-mod")
		expect(parsed.recipes.map((a) => a.id)).toEqual(["write"])
	})

	it("pack test honest-mod/write materializes and does not leak temp dirs", async () => {
		const cwd = fixtureProject("baka-mod-test-")
		const before = countBakaTestDirs()
		const { code, stdout, stderr } = await spawnCli({
			argv: ["pack", "test", "honest-mod", "--recipe", "write", "--input", "{}"],
			cwd,
		})
		expect(code, stderr).toBe(0)
		expect(stdout).toContain("RESULT:")
		expect(countBakaTestDirs()).toBe(before)
	})

	it("missing --recipe and unknown --recipe exit 1 without creating temp dirs", async () => {
		const cwd = fixtureProject("baka-mod-test-bad-")
		const before = countBakaTestDirs()
		const missing = await spawnCli({ argv: ["pack", "test", "honest-mod"], cwd })
		expect(missing.code).toBe(1)
		expect(missing.stderr).toContain("--recipe")
		const unknown = await spawnCli({
			argv: ["pack", "test", "honest-mod", "--recipe", "no-such-recipe"],
			cwd,
		})
		expect(unknown.code).toBe(1)
		expect(unknown.stderr).toContain("no-such-recipe")
		expect(countBakaTestDirs()).toBe(before)
	})
})

describe("plan / apply / validate", () => {
	it("plan --help lists dry-run, save, json and never --execute", async () => {
		const { code, stdout } = await spawnCli({ argv: ["plan", "--help"] })
		expect(code).toBe(0)
		expect(stdout).toContain("--dry-run")
		expect(stdout).toContain("--save")
		expect(stdout).toContain("--json")
		expect(stdout).not.toContain("--execute")
	})

	it("plan without a worker role exits 1", async () => {
		const fakeHome = makeEmptyDir("baka-plan-no-role-")
		const { code, stderr } = await spawnCli({
			argv: ["plan", "write a marker"],
			cwd: fixtureProject("baka-plan-no-role-proj-"),
			env: { HOME: fakeHome, XDG_CONFIG_HOME: fakeHome, XDG_DATA_HOME: fakeHome },
		})
		expect(code).toBe(1)
		expect(stderr).toContain("missing LLM config: worker role not configured")
	})

	it("apply of a missing plan file exits 2", async () => {
		const cwd = fixtureProject("baka-apply-missing-")
		const { code, stderr } = await spawnCli({
			argv: ["apply", join(cwd, "no-such.plan.json")],
			cwd,
		})
		expect(code).toBe(2)
		expect(stderr.length).toBeGreaterThan(0)
	})

	it("apply of a non-reasoning fixture plan writes files with no LLM config", async () => {
		const cwd = fixtureProject("baka-apply-nollm-")
		const plansDir = join(cwd, ".baka", "plans")
		mkdirSync(plansDir, { recursive: true })
		const planFile = join(plansDir, "write.plan.json")
		writeFileSync(
			planFile,
			JSON.stringify({
				resolvedSteps: [{ id: "step-1", pack: "honest-mod", recipe: "write", params: {} }],
				meta: { intent: "write marker", savedAt: "2026-08-25T00:00:00.000Z" },
			}),
		)
		const fakeHome = makeEmptyDir("baka-apply-nollm-home-")
		const { code, stdout, stderr } = await spawnCli({
			argv: ["apply", planFile, "--json"],
			cwd,
			env: { HOME: fakeHome, XDG_CONFIG_HOME: fakeHome, XDG_DATA_HOME: fakeHome },
		})
		expect(code, stderr).toBe(0)
		const parsed = JSON.parse(stdout) as { status: string; completedSteps: Array<{ pack: string; recipe: string }> }
		expect(parsed.status).toBe("SUCCESS")
		expect(parsed.completedSteps[0]).toMatchObject({ pack: "honest-mod", recipe: "write" })
		expect(readFileSync(join(cwd, "marker.txt"), "utf-8")).toBe("honest-mod was here\n")
	})

	it("validate from an empty cwd reports 0 packs", async () => {
		const fakeHome = makeEmptyDir("baka-validate-empty-home-")
		const { code, stdout, stderr } = await spawnCli({
			argv: ["validate"],
			cwd: EMPTY_CWD,
			env: { HOME: fakeHome, XDG_CONFIG_HOME: fakeHome, XDG_DATA_HOME: fakeHome },
		})
		expect(code, stderr).toBe(0)
		expect(stdout).toMatch(/discovered 0 pack\(s\)/)
	})

	it("validate --json on a fixture project discovers those packs", async () => {
		const cwd = fixtureProject("baka-validate-fx-")
		const fakeHome = makeEmptyDir("baka-validate-fx-home-")
		const { code, stdout, stderr } = await spawnCli({
			argv: ["validate", "--json"],
			cwd,
			env: { HOME: fakeHome, XDG_CONFIG_HOME: fakeHome, XDG_DATA_HOME: fakeHome },
		})
		expect([0, 4], stderr).toContain(code)
		const parsed = JSON.parse(stdout) as { packsDiscovered: number; validation: { kind: string } }
		expect(parsed.packsDiscovered).toBe(2)
		expect(["pass", "fail"]).toContain(parsed.validation.kind)
	})

	it("validate -m names an unknown pack", async () => {
		const cwd = fixtureProject("baka-validate-unknown-")
		const { code, stderr } = await spawnCli({
			argv: ["validate", "-m", "nonexistent"],
			cwd,
		})
		expect(code).toBe(1)
		expect(stderr).toContain('pack "nonexistent" not found')
	})
})

describe("hyphenated recipe ids load", () => {
	it("pack test runs write-file on an inline fixture", async () => {
		const cwd = makeEmptyDir("baka-hyphen-")
		const mod = join(cwd, "packs", "hyphen-mod")
		mkdirSync(join(mod, "write-file", "templates"), { recursive: true })
		writeFileSync(
			join(mod, "manifest.ts"),
			`export const Manifest = {
  name: "hyphen-mod",
  version: "0.0.0",
  description: "hyphenated recipe id",
  dependencies: [],
  conflictsWith: [],
  recipes: [{
    id: "write-file",
    description: "write a file",
    params: [],
    requiresReasoning: false,
    filePatterns: ["out.txt"],
    validators: [],
  }],
  packValidators: [],
}
`,
		)
		writeFileSync(join(mod, "write-file", "templates", "out.txt.hbs"), "ok\n")
		const { code, stdout, stderr } = await spawnCli({
			argv: ["pack", "test", "hyphen-mod", "--recipe", "write-file", "--input", "{}"],
			cwd,
		})
		expect(code, stderr).toBe(0)
		expect(stdout).toContain("RESULT:")
	})
})

describe("unloadable recipe.ts fails pack validate", () => {
	it("reports valid: false", async () => {
		const cwd = makeEmptyDir("baka-unloadable-")
		const recipeDir = join(cwd, "packs", "unloadable-mod", "bad-recipe")
		mkdirSync(recipeDir, { recursive: true })
		writeFileSync(
			join(cwd, "packs", "unloadable-mod", "manifest.ts"),
			`export const Manifest = {
  name: "unloadable-mod",
  version: "0.1.0",
  description: "unloadable",
  dependencies: [],
  conflictsWith: [],
  recipes: [{
    id: "bad-recipe",
    description: "bad",
    requiresReasoning: false,
    filePatterns: [],
    validators: [],
    params: [],
  }],
  packValidators: [],
}
`,
		)
		writeFileSync(
			join(recipeDir, "recipe.ts"),
			`export const somethingElse = { execute: async () => ({ success: true }), compensate: async () => {} }
`,
		)
		const { code, stdout, stderr } = await spawnCli({
			argv: ["pack", "validate", "unloadable-mod", "--json"],
			cwd,
		})
		expect(code, stderr).toBe(4)
		const parsed = JSON.parse(stdout) as { valid: boolean; errors: string[] }
		expect(parsed.valid).toBe(false)
		expect(parsed.errors.some((e) => e.includes("bad-recipe") && e.includes("not loadable"))).toBe(true)
	})
})
