// ---------------------------------------------------------------------------
// End-to-end tests for the `baka module create <name>` CLI after the
// role-keyed config refactor.
//
// These tests spawn the actual built CLI (`node apps/cli/dist/index.js`)
// and assert on what the user sees. Two flavors:
//
//   1. Fast, hermetic, in-process fake LLM. Default; runs in CI.
//      Uses a small HTTP server bound to port 0 to serve scripted
//      responses, so there's no real LLM, no network, no flake.
//
//   2. Slow, real LLM (gemma4:e4b-it on localhost:8080). Gated by
//      RUN_REAL_LLM=1. Skipped by default. This is the source of truth
//      for the user-facing experience.
//
// Why two flavors?
//   - The fast one proves the CLI's REPL wiring is correct on every commit.
//   - The real-LLM one proves the *behavior* holds against the actual
//     LLM the user runs, where prompt rendering, JSON parsing, and
//     schema validation interact in ways a fake can't reproduce.
//
// Layer hierarchy:
//   - workflow unit tests (chat.test.ts)            — no I/O
//   - CLI unit tests (module-design/*.test.ts)      — no I/O
//   - THIS test                                      — subprocess
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, test } from "vitest"

interface ScriptedResponse {
	content: string
}

function startFakeLLM(script: ScriptedResponse[]): Promise<{ url: string; close: () => Promise<void>; calls: number }> {
	let calls = 0
	let scriptIdx = 0
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.url !== "/v1/chat/completions" && req.url !== "/chat/completions") {
			res.statusCode = 404
			res.end("not found")
			return
		}
		let body = ""
		req.on("data", (chunk) => (body += chunk))
		req.on("end", () => {
			calls++
			const next = script[scriptIdx++] ?? script[script.length - 1]
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
							message: { role: "assistant", content: next.content },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
				}),
			)
		})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr === "object" && addr) {
				resolve({
					url: `http://127.0.0.1:${addr.port}`,
					close: () =>
						new Promise<void>((res) => {
							server.close(() => res())
						}),
					get calls() {
						return calls
					},
				} as { url: string; close: () => Promise<void>; calls: number })
			}
		})
	})
}

/**
 * Write a baka config to <home>/.baka/config.json with the role-keyed
 * shape that the refactor produces. The worker role is required (the
 * module-design flow uses it); the validator role is omitted here
 * because module-design does not need it.
 */
function seedRoleConfig(home: string, cfg: { baseUrl: string; model: string; apiKey?: string }) {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify(
			{
				worker: {
					baseUrl: cfg.baseUrl,
					model: cfg.model,
					apiKey: cfg.apiKey ?? "test-worker-key",
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

function spawnBaka(args: {
	cwd: string
	env: Record<string, string>
	bakaConfig?: { baseUrl: string; model: string; apiKey?: string }
}): Promise<{
	code: number | null
	stdout: string
	stderr: string
}> {
	return new Promise((resolve) => {
		const cli = join(__dirname, "..", "dist", "index.js")
		if (!existsSync(cli)) {
			throw new Error(`built CLI not found at ${cli}; run \`pnpm --filter baka build\` first`)
		}
		let env: Record<string, string> = { ...process.env, ...args.env }
		if (args.bakaConfig) {
			const home = join(args.cwd, ".fake-home")
			seedRoleConfig(home, args.bakaConfig)
			env = { ...env, HOME: home }
		}
		const child: ChildProcess = spawn("node", [cli, "--cwd", args.cwd, "module", "create", "testmod"], {
			env,
			cwd: args.cwd,
		})
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		child.on("close", (code) => resolve({ code, stdout, stderr }))
	})
}

describe("baka module create — fast (fake LLM, real CLI binary)", () => {
	let tmpDir: string

	beforeAll(async () => {
		// Build the CLI once for the test run.
		const { spawnSync } = await import("node:child_process")
		const buildResult = spawnSync("pnpm", ["--filter", "baka", "run", "build"], {
			cwd: join(__dirname, "..", "..", ".."),
			encoding: "utf-8",
		})
		if (buildResult.status !== 0) {
			throw new Error(`CLI build failed: ${buildResult.stderr}`)
		}
	})

	afterEach(() => {
		if (tmpDir && existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	test("the user always sees the LLM's first response before being asked to type", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-e2e-"))
		const responsesFile = join(tmpDir, "responses.txt")
		writeFileSync(responsesFile, "ok\n/exit\n")

		const llm = await startFakeLLM([
			{
				content: JSON.stringify({
					phase: "DISCOVER",
					message: "Welcome! I need a few questions to scope this module.",
					questions: [{ id: "domain", prompt: "What is the target framework?", whyWeNeedThis: "framing" }],
					finished: false,
				}),
			},
		])

		try {
			const { stdout } = await spawnBaka({
				cwd: tmpDir,
				env: {
					BAKA_E2E_BRIEF: "a SSOT for all things next.js v16 app router",
					BAKA_E2E_INPUT: responsesFile,
				},
				bakaConfig: { baseUrl: llm.url, model: "fake-llm" },
			})

			// The bootstrap LLM was called at least once.
			expect(llm.calls).toBeGreaterThanOrEqual(1)

			// The assistant's first message appears BEFORE the first
			// user prompt. This is the user-facing promise: no bare `> `.
			const assistantIdx = stdout.indexOf("Welcome! I need a few questions")
			const firstPromptIdx = stdout.indexOf("> ")
			expect(assistantIdx).toBeGreaterThan(-1)
			expect(firstPromptIdx).toBeGreaterThan(-1)
			expect(assistantIdx).toBeLessThan(firstPromptIdx)

			// The user sees the phase context.
			expect(stdout).toContain("[phase: DISCOVER]")
			// The user sees the slash command help on the first prompt.
			expect(stdout).toContain("/exit")
			expect(stdout).toContain("/show prefs")
			expect(stdout).toContain("/back")
			// The brief is visible.
			expect(stdout).toContain("a SSOT for all things next.js v16 app router")
		} finally {
			await llm.close()
		}
	}, 60_000)

	test("the questions the LLM asks are rendered as a structured list, not as a blob", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-e2e-"))
		const responsesFile = join(tmpDir, "responses.txt")
		writeFileSync(responsesFile, "ok\n/exit\n")

		const llm = await startFakeLLM([
			{
				content: JSON.stringify({
					phase: "DISCOVER",
					message: "Let me ask a few things.",
					questions: [
						{ id: "domain", prompt: "What is the target framework?", whyWeNeedThis: "framing" },
						{ id: "scope", prompt: "What is in scope?", whyWeNeedThis: "to bound the work" },
					],
					finished: false,
				}),
			},
		])

		try {
			const { stdout } = await spawnBaka({
				cwd: tmpDir,
				env: {
					BAKA_E2E_BRIEF: "a SSOT for all things next.js v16 app router",
					BAKA_E2E_INPUT: responsesFile,
				},
				bakaConfig: { baseUrl: llm.url, model: "fake-llm" },
			})

			expect(stdout).toContain("[domain] What is the target framework?")
			expect(stdout).toContain("[scope] What is in scope?")
		} finally {
			await llm.close()
		}
	}, 60_000)

	test("the user can advance through DISCOVER -> DEFINE -> DEVELOP with the proposed action roster visible", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-e2e-"))
		const responsesFile = join(tmpDir, "responses.txt")
		writeFileSync(responsesFile, "ok\nok\nok\nok\nok\nok\nok\nexit\nok\n")

		const llm = await startFakeLLM([
			{
				content: JSON.stringify({
					phase: "DISCOVER",
					message: "Tell me about your domain.",
					questions: [{ id: "domain", prompt: "What?", whyWeNeedThis: "framing" }],
					finished: false,
				}),
			},
			{
				content: JSON.stringify({
					phase: "DISCOVER",
					message: "Got it.",
					questions: [],
					finished: true,
					synthesizedPrefs: "## Domain\ntest",
				}),
			},
			{
				content: JSON.stringify({
					phase: "DEFINE",
					message: "Proposed action roster.",
					actions: [{ id: "scaffold", description: "Scaffold a TS project", rationale: "sets the baseline" }],
					finished: true,
				}),
			},
			{
				content: JSON.stringify({
					phase: "DEVELOP",
					message: "Designed scaffold.",
					actions: [
						{
							id: "scaffold",
							params: [{ name: "name", type: "string", required: true, description: "name" }],
							requiresReasoning: false,
							compensatesWith: null,
							validators: [],
							testIntent: "scaffold a ts app",
						},
					],
					finished: true,
				}),
			},
		])

		try {
			const { stdout } = await spawnBaka({
				cwd: tmpDir,
				env: {
					BAKA_E2E_BRIEF: "a SSOT for all things next.js v16 app router",
					BAKA_E2E_INPUT: responsesFile,
				},
				bakaConfig: { baseUrl: llm.url, model: "fake-llm" },
			})

			expect(llm.calls).toBeGreaterThanOrEqual(2)
			expect(stdout).toContain("[phase: DISCOVER]")
			expect(stdout).toContain("[phase: DEFINE]")
			expect(stdout).toContain("[phase: DEVELOP]")
			expect(stdout).toContain("Proposed actions")
			expect(stdout).toContain("scaffold")
		} finally {
			await llm.close()
		}
	}, 60_000)

	test("if the bootstrap LLM call fails, the user sees a clear error instead of a silent bare prompt", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-e2e-"))
		const responsesFile = join(tmpDir, "responses.txt")
		writeFileSync(responsesFile, "ok\n/exit\n")

		const llm = await startFakeLLM([{ content: "this is not json" }, { content: "this is not json either" }])

		try {
			const { stdout, stderr } = await spawnBaka({
				cwd: tmpDir,
				env: {
					BAKA_E2E_BRIEF: "a SSOT for all things next.js v16 app router",
					BAKA_E2E_INPUT: responsesFile,
				},
				bakaConfig: { baseUrl: llm.url, model: "fake-llm" },
			})

			const combined = stdout + stderr
			expect(combined).toMatch(/bootstrap LLM call failed/i)
			expect(stdout).toContain("[phase: DISCOVER]")
			expect(stdout).toContain("/exit")
		} finally {
			await llm.close()
		}
	}, 60_000)
})

// ---------------------------------------------------------------------------
// Slow flavor: real LLM, same behaviors. Skipped by default; opt in
// with RUN_REAL_LLM=1.
//
// This block uses the user's actual configured LLM (llama_cpp /
// gemma4:e4b-it on localhost:8080 by default) to prove the same
// behaviors hold end-to-end against the real thing. It's slow because
// the LLM is real, and non-deterministic because the LLM is real. We
// only assert structural properties.
// ---------------------------------------------------------------------------

const REAL_LLM_BASE_URL = process.env.REAL_LLM_BASE_URL ?? "http://localhost:8080"
const REAL_LLM_MODEL = process.env.REAL_LLM_MODEL ?? "gemma4:e4b-it"
const runReal = process.env.RUN_REAL_LLM === "1"
const describeIfReal = runReal ? describe : describe.skip

describeIfReal("baka module create — slow (real LLM, real CLI binary)", () => {
	let tmpDir: string

	beforeAll(async () => {
		const { spawnSync } = await import("node:child_process")
		const buildResult = spawnSync("pnpm", ["--filter", "baka", "run", "build"], {
			cwd: join(__dirname, "..", "..", ".."),
			encoding: "utf-8",
		})
		if (buildResult.status !== 0) {
			throw new Error(`CLI build failed: ${buildResult.stderr}`)
		}
		const { execSync } = await import("node:child_process")
		try {
			execSync(`curl -fsS --max-time 5 ${REAL_LLM_BASE_URL}/v1/models > /dev/null`)
		} catch (_err) {
			throw new Error(
				`LLM is not reachable at ${REAL_LLM_BASE_URL}. Start your local llama-server or set REAL_LLM_BASE_URL.`,
			)
		}
		execSync(
			`curl -fsS --max-time 120 -X POST ${REAL_LLM_BASE_URL}/v1/chat/completions ` +
				`-H "Content-Type: application/json" ` +
				`-d '{"model":"${REAL_LLM_MODEL}","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null`,
		)
	}, 180_000)

	afterEach(() => {
		if (tmpDir && existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	test("the user always sees context before being asked to type", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "baka-real-llm-"))
		const responsesFile = join(tmpDir, "responses.txt")
		writeFileSync(
			responsesFile,
			"next.js v16 with the app router, server-first, server actions, cache components\n" +
				"SSOT for next.js v16 app router patterns\n" +
				"BaaS\n" +
				"the four dev use cases: create route, server action, fetch with cache components, validate\n" +
				"BaaS\n" +
				"we own the SSOT\n" +
				"ok\n" +
				"ok\n" +
				"ok\n" +
				"ok\n" +
				"/exit\n",
		)

		const cli = join(__dirname, "..", "dist", "index.js")
		if (!existsSync(cli)) throw new Error(`built CLI not found at ${cli}`)
		const realHome = join(tmpDir, ".fake-home")
		seedRoleConfig(realHome, { baseUrl: REAL_LLM_BASE_URL, model: REAL_LLM_MODEL })
		const child: ChildProcess = spawn("node", [cli, "--cwd", tmpDir, "module", "create", "nextjs"], {
			env: {
				...process.env,
				HOME: realHome,
				BAKA_E2E_BRIEF: "a SSOT for all things next.js v16 app router related, server-first, server actions, etc.",
				BAKA_E2E_INPUT: responsesFile,
			},
			cwd: tmpDir,
		})
		const stdout: string[] = []
		const stderr: string[] = []
		child.stdout?.on("data", (b: Buffer) => stdout.push(b.toString()))
		child.stderr?.on("data", (b: Buffer) => stderr.push(b.toString()))
		await new Promise<void>((resolve) => child.on("close", () => resolve()))
		const out = stdout.join("")
		const _err = stderr.join("")

		expect(out).toContain("a SSOT for all things next.js v16 app router")
		expect(out).toMatch(/\[phase: \w+\]/)
		expect(out).toContain("/exit")
		expect(out).toContain("/show prefs")
		expect(out).toContain("/back")
		expect(out).toMatch(/session saved to/)
		const firstPromptIdx = out.indexOf("> ")
		const beforeFirstPrompt = out.slice(0, firstPromptIdx)
		const linesBeforePrompt = beforeFirstPrompt.split("\n").filter((l) => l.trim().length > 0).length
		expect(linesBeforePrompt).toBeGreaterThan(5)
	}, 300_000)
})
