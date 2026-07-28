// ---------------------------------------------------------------------------
// Foundation-fix tests for the role config & credential hygiene contract.
//
// Every probe spawns the BUILT CLI (`apps/cli/dist/index.js`) as a subprocess
// with an isolated BAKA_HOME (architecture decision 33) and HOME pointed at a
// different throwaway dir, so the tests also prove BAKA_HOME wins over $HOME.
//
// Coverage map (validation-contract.md):
//   VAL-FOUND-045  corrupt user config fails honestly on every reading command
//   VAL-FOUND-047  role block missing required fields fails fast naming role+field
//   VAL-FOUND-048  `baka role` rejects unknown roles/fields with named alternatives
//   VAL-FOUND-049  apiKey never leaks into plans, plan files, output, or logs
//   VAL-FOUND-050  apiKey is masked in every read surface
//   decision 33    BAKA_HOME replaces ~/.baka entirely (role path, config
//                  writes, user-scope installs)
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const HONEST_MOD_FIXTURE = join(BAKA_REPO, "apps", "cli", "test", "fixtures", "honest-mod")
const SENTINEL = "sk-SENTINEL-DO-NOT-LEAK-12345"

interface SpawnResult {
	code: number | null
	stdout: string
	stderr: string
}

function spawnCli(argv: string[], cwd: string, env: Record<string, string>, timeoutMs = 60_000): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...argv], { cwd, env: { ...process.env, ...env } })
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve({ code: null, stdout, stderr: `${stderr}\n[test: killed after ${timeoutMs}ms]` })
		}, timeoutMs)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

const createdDirs: string[] = []
function makeEmptyDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix))
	createdDirs.push(d)
	return d
}

/** An isolated BAKA_HOME plus a DISTINCT throwaway HOME, so any code path
 * that still follows $HOME is caught. */
function makeIsolatedHome(prefix: string): { bakaHome: string; home: string; env: Record<string, string> } {
	const bakaHome = join(makeEmptyDir(prefix), "baka-home")
	const home = makeEmptyDir(`${prefix}home-`)
	mkdirSync(bakaHome, { recursive: true })
	return { bakaHome, home, env: { BAKA_HOME: bakaHome, HOME: home } }
}

function configPath(bakaHome: string): string {
	return join(bakaHome, "config.json")
}

function seedConfig(bakaHome: string, cfg: Record<string, unknown>): void {
	mkdirSync(bakaHome, { recursive: true })
	writeFileSync(configPath(bakaHome), JSON.stringify(cfg, null, 2))
}

function workerBlock(baseUrl: string, apiKey: string = SENTINEL): Record<string, unknown> {
	return { baseUrl, model: "fake-llm", apiKey, temperature: 0, maxTokens: 8192, timeoutMs: 120_000 }
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
		let body = ""
		req.on("data", (chunk: Buffer) => (body += chunk))
		req.on("end", () => {
			calls++
			res.setHeader("Content-Type", "application/json")
			res.end(
				JSON.stringify({
					id: `fake-${calls}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: "fake-llm",
					choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				}),
			)
		})
	})
	return new Promise((resolve, reject) => {
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (typeof addr !== "object" || !addr) {
				reject(new Error("fake LLM: failed to bind"))
				return
			}
			resolve({
				url: `http://127.0.0.1:${addr.port}/v1`,
				get calls() {
					return calls
				},
				close: () =>
					new Promise<void>((res) => {
						server.close(() => res())
					}),
			})
		})
	})
}

function planResponse(): string {
	return JSON.stringify({
		resolvedSteps: [{ id: "step-1", module: "honest-mod", action: "write", params: {} }],
	})
}

function prepareScratchWithFixture(prefix: string): string {
	const scratch = makeEmptyDir(prefix)
	mkdirSync(join(scratch, "modules"), { recursive: true })
	symlinkSync(HONEST_MOD_FIXTURE, join(scratch, "modules", "honest-mod"))
	return scratch
}

/** Recursively collect every file's text content under root. */
function readAllFiles(root: string): Array<{ path: string; text: string }> {
	const out: Array<{ path: string; text: string }> = []
	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(full)
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				try {
					out.push({ path: full, text: readFileSync(full, "utf-8") })
				} catch {
					/* unreadable/binary; skip */
				}
			}
		}
	}
	if (existsSync(root)) walk(root)
	return out
}

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
})

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// VAL-FOUND-045  corrupt config fails honestly on every reading command
// ---------------------------------------------------------------------------

describe("VAL-FOUND-045 corrupt user config fails honestly on every reading command", () => {
	it("baka roles, baka plan, and baka role --field all fail naming the corrupt path; the file is untouched", async () => {
		const { bakaHome, env } = makeIsolatedHome("baka-hyg-corrupt-")
		const scratch = prepareScratchWithFixture("baka-hyg-corrupt-proj-")
		const corruptBytes = "{not json"
		mkdirSync(bakaHome, { recursive: true })
		writeFileSync(configPath(bakaHome), corruptBytes)
		const path = configPath(bakaHome)

		const roles = await spawnCli(["roles"], scratch, env)
		expect(roles.code, `roles: expected non-zero exit; stdout=${roles.stdout}`).not.toBe(0)
		expect(roles.stderr).toContain(path)
		expect(roles.stderr).toMatch(/corrupt/)
		expect(roles.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(roles.stderr).not.toMatch(/baka:\s*baka:/)

		const plan = await spawnCli(["--cwd", scratch, "plan", "write a marker", "--json"], scratch, env)
		expect(plan.code, `plan: expected non-zero exit; stdout=${plan.stdout}`).not.toBe(0)
		expect(plan.stderr).toContain(path)
		expect(plan.stderr).toMatch(/corrupt/)
		expect(plan.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)

		const role = await spawnCli(["role", "worker", "--field", "model", "--value", "x"], scratch, env)
		expect(role.code, `role: expected exit 1; stdout=${role.stdout}`).toBe(1)
		expect(role.stderr).toContain(path)
		expect(role.stderr).toMatch(/corrupt/)

		// No silent treatment as empty config, no partial write.
		expect(readFileSync(path, "utf-8")).toBe(corruptBytes)
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-047  role block missing required fields fails fast (decision 13)
// ---------------------------------------------------------------------------

describe("VAL-FOUND-047 role block missing a required field fails fast naming role+field", () => {
	it("missing model, missing baseUrl, and missing apiKey each fail before any network call", async () => {
		const llm = await startFakeLLM(planResponse())
		try {
			const cases: Array<{ label: string; block: Record<string, unknown>; field: string }> = [
				{ label: "model", block: { baseUrl: llm.url, apiKey: SENTINEL }, field: "model" },
				{ label: "baseUrl", block: { model: "fake-llm", apiKey: SENTINEL }, field: "baseUrl" },
				{ label: "apiKey", block: { baseUrl: llm.url, model: "fake-llm" }, field: "apiKey" },
			]
			for (const c of cases) {
				const { bakaHome, env } = makeIsolatedHome(`baka-hyg-missing-${c.label}-`)
				const scratch = prepareScratchWithFixture(`baka-hyg-missing-${c.label}-proj-`)
				seedConfig(bakaHome, { worker: c.block })

				const { code, stdout, stderr } = await spawnCli(
					["--cwd", scratch, "plan", "write a marker", "--json"],
					scratch,
					env,
				)
				expect(code, `${c.label}: expected exit 1; stdout=${stdout}; stderr=${stderr}`).toBe(1)
				expect(stderr, `${c.label}: error must name the role`).toContain("worker")
				expect(stderr, `${c.label}: error must name the field`).toContain(c.field)
				expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
				// The sentinel must never appear in error output either.
				expect(stderr + stdout).not.toContain(SENTINEL)
			}
			expect(llm.calls, "fail-fast happened before any network call").toBe(0)
		} finally {
			await llm.close()
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-048  unknown roles/fields rejected with named alternatives
// ---------------------------------------------------------------------------

describe("VAL-FOUND-048 baka role rejects unknown roles and fields with named alternatives", () => {
	it("unknown role, unknown field, and non-numeric value all exit 1 with named alternatives; config untouched", async () => {
		const { bakaHome, env } = makeIsolatedHome("baka-hyg-unknown-")
		const scratch = makeEmptyDir("baka-hyg-unknown-proj-")
		seedConfig(bakaHome, { worker: workerBlock("http://127.0.0.1:1/v1") })
		const beforeBytes = readFileSync(configPath(bakaHome), "utf-8")

		const unknownRole = await spawnCli(["role", "plumber", "--field", "model", "--value", "x"], scratch, env)
		expect(unknownRole.code, `unknown role: expected exit 1; stdout=${unknownRole.stdout}`).toBe(1)
		expect(unknownRole.stderr).toContain("plumber")
		expect(unknownRole.stderr).toContain("worker, validator")

		const unknownField = await spawnCli(["role", "worker", "--field", "bogus", "--value", "x"], scratch, env)
		expect(unknownField.code, `unknown field: expected exit 1; stdout=${unknownField.stdout}`).toBe(1)
		expect(unknownField.stderr).toContain(`unknown field "bogus"`)
		expect(unknownField.stderr).toContain("baseUrl, model, apiKey, temperature, maxTokens, timeoutMs")

		const badNumber = await spawnCli(["role", "worker", "--field", "maxTokens", "--value", "abc"], scratch, env)
		expect(badNumber.code, `bad number: expected exit 1; stdout=${badNumber.stdout}`).toBe(1)
		expect(badNumber.stderr).toMatch(/maxTokens.*must be a number/)

		expect(readFileSync(configPath(bakaHome), "utf-8"), "config file mutated by rejected edits").toBe(beforeBytes)
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-049  apiKey never leaks into plans, plan files, output, or logs
// ---------------------------------------------------------------------------

describe("VAL-FOUND-049 the configured apiKey never leaks", () => {
	it("plan --save + apply leave the sentinel only inside config.json", async () => {
		const { bakaHome, env } = makeIsolatedHome("baka-hyg-leak-")
		const scratch = prepareScratchWithFixture("baka-hyg-leak-proj-")
		const llm = await startFakeLLM(planResponse())
		seedConfig(bakaHome, { worker: workerBlock(llm.url) })

		try {
			const plan = await spawnCli(["--cwd", scratch, "plan", "write a marker", "--save", "--json"], scratch, env)
			expect(plan.code, `plan failed: ${plan.stderr}`).toBe(0)
			const parsed = JSON.parse(plan.stdout) as { planFile?: string }
			expect(typeof parsed.planFile).toBe("string")

			const apply = await spawnCli(["--cwd", scratch, "apply", parsed.planFile as string, "--json"], scratch, env)
			expect(apply.code, `apply failed: ${apply.stderr}`).toBe(0)

			expect(plan.stdout + plan.stderr, "sentinel in plan output").not.toContain(SENTINEL)
			expect(apply.stdout + apply.stderr, "sentinel in apply output").not.toContain(SENTINEL)

			// Every file under the project tree and the isolated home: the
			// sentinel may appear ONLY in the config file itself.
			for (const f of [...readAllFiles(scratch), ...readAllFiles(bakaHome)]) {
				if (f.path === configPath(bakaHome)) continue
				expect(f.text, `sentinel leaked into ${f.path}`).not.toContain(SENTINEL)
			}
		} finally {
			await llm.close()
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-050  apiKey masked in every read surface
// ---------------------------------------------------------------------------

describe("VAL-FOUND-050 apiKey is masked in every read surface", () => {
	it("baka roles, baka role show, and baka role path never print the sentinel", async () => {
		const { bakaHome, env } = makeIsolatedHome("baka-hyg-mask-")
		const scratch = makeEmptyDir("baka-hyg-mask-proj-")
		seedConfig(bakaHome, { worker: workerBlock("http://127.0.0.1:1/v1") })

		const roles = await spawnCli(["roles"], scratch, env)
		expect(roles.code, `roles failed: ${roles.stderr}`).toBe(0)
		expect(roles.stdout).toContain("apiKey:")
		expect(roles.stdout).toContain("<set>")
		expect(roles.stdout, "sentinel in `baka roles`").not.toContain(SENTINEL)

		const show = await spawnCli(["role", "show", "worker"], scratch, env)
		expect(show.code, `role show failed: ${show.stderr}`).toBe(0)
		expect(show.stdout).toContain("apiKey:")
		expect(show.stdout).toContain("<set>")
		expect(show.stdout, "sentinel in `baka role show worker`").not.toContain(SENTINEL)

		const pathRun = await spawnCli(["role", "path"], scratch, env)
		expect(pathRun.code, `role path failed: ${pathRun.stderr}`).toBe(0)
		expect(pathRun.stdout, "sentinel in `baka role path`").not.toContain(SENTINEL)
	}, 120_000)
})

// ---------------------------------------------------------------------------
// Decision 33  BAKA_HOME replaces ~/.baka entirely (CLI surface)
// ---------------------------------------------------------------------------

describe("decision 33: BAKA_HOME replaces ~/.baka entirely", () => {
	it("baka role path prints $BAKA_HOME/config.json, not $HOME/.baka/config.json", async () => {
		const { bakaHome, home, env } = makeIsolatedHome("baka-hyg-home-")
		const scratch = makeEmptyDir("baka-hyg-home-proj-")

		const { code, stdout, stderr } = await spawnCli(["role", "path"], scratch, env)
		expect(code, `role path failed: ${stderr}`).toBe(0)
		expect(stdout.trim()).toBe(configPath(bakaHome))
		expect(stdout.trim()).not.toBe(join(home, ".baka", "config.json"))
	})

	it("baka role --field writes $BAKA_HOME/config.json and never touches $HOME/.baka", async () => {
		const { bakaHome, home, env } = makeIsolatedHome("baka-hyg-write-")
		const scratch = makeEmptyDir("baka-hyg-write-proj-")
		seedConfig(bakaHome, { worker: workerBlock("http://127.0.0.1:1/v1") })

		const { code, stderr } = await spawnCli(
			["role", "worker", "--field", "model", "--value", "new-model"],
			scratch,
			env,
		)
		expect(code, `role --field failed: ${stderr}`).toBe(0)

		const after = JSON.parse(readFileSync(configPath(bakaHome), "utf-8")) as { worker: { model: string } }
		expect(after.worker.model).toBe("new-model")
		expect(existsSync(join(home, ".baka")), "$HOME/.baka was created").toBe(false)
	})

	it("baka install --user materializes under $BAKA_HOME/modules", async () => {
		const { bakaHome, home, env } = makeIsolatedHome("baka-hyg-install-")
		const scratch = makeEmptyDir("baka-hyg-install-proj-")

		const { code, stdout, stderr } = await spawnCli(
			["--cwd", scratch, "install", HONEST_MOD_FIXTURE, "--user"],
			scratch,
			env,
		)
		expect(code, `install --user failed: stdout=${stdout}; stderr=${stderr}`).toBe(0)
		expect(existsSync(join(bakaHome, "modules", "honest-mod", "manifest.ts"))).toBe(true)
		expect(existsSync(join(home, ".baka")), "$HOME/.baka was created").toBe(false)

		// And discovery sees the user-scope install through the same BAKA_HOME.
		const list = await spawnCli(["--cwd", scratch, "list-modules", "--json"], scratch, env)
		expect(list.code, `list-modules failed: ${list.stderr}`).toBe(0)
		const parsed = JSON.parse(list.stdout) as { modules: Array<{ name: string }> }
		expect(parsed.modules.map((m) => m.name)).toContain("honest-mod")
	}, 120_000)
})
