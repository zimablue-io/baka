// ---------------------------------------------------------------------------
// Foundation-fix tests for the plan/apply honesty contract.
//
// Every probe spawns the BUILT CLI (`apps/cli/dist/index.js`) as a subprocess
// against a temp project with a hermetic fake LLM. The tests assert that
// `baka plan` (with and without --dry-run) never mutates the project tree,
// that `--save` persists a loadable plan, and that `baka apply` is the only
// execution path.
//
// Coverage map (validation-contract.md):
//   VAL-FOUND-001  `baka plan` never mutates the project tree
//   VAL-FOUND-002  `baka plan --dry-run` never mutates the project tree
//   VAL-FOUND-005  `baka plan --save` persists a loadable plan
//   VAL-FOUND-007  `baka apply <plan-file>` executes a saved plan
//   VAL-FOUND-010  No dead `--execute` branch in `baka plan`
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
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
import { join, relative } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const HONEST_MOD_FIXTURE = join(BAKA_REPO, "apps", "cli", "test", "fixtures", "honest-mod")

interface SpawnResult {
	code: number | null
	stdout: string
	stderr: string
}

function spawnCli(
	argv: string[],
	cwd: string,
	env: Record<string, string> = {},
	timeoutMs = 30_000,
): Promise<SpawnResult> {
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

interface RoleBlock {
	baseUrl: string
	model: string
	apiKey?: string
}

function seedRoleConfig(home: string, worker: RoleBlock, validator?: RoleBlock): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	const out: Record<string, unknown> = {
		worker: {
			baseUrl: worker.baseUrl,
			model: worker.model,
			apiKey: worker.apiKey ?? "test-worker-key",
			temperature: 0,
			maxTokens: 8192,
			timeoutMs: 120_000,
		},
	}
	if (validator) {
		out.validator = {
			baseUrl: validator.baseUrl,
			model: validator.model,
			apiKey: validator.apiKey ?? "test-validator-key",
			temperature: 0,
			maxTokens: 8192,
			timeoutMs: 120_000,
		}
	}
	writeFileSync(join(dir, "config.json"), JSON.stringify(out, null, 2))
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
					choices: [
						{
							index: 0,
							message: { role: "assistant", content },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
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
		resolvedSteps: [
			{
				id: "step-1",
				module: "honest-mod",
				action: "write",
				params: {},
			},
		],
	})
}

function makeEmptyDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

function prepareScratchWithFixture(prefix: string): string {
	const scratch = trackDir(makeEmptyDir(prefix))
	mkdirSync(join(scratch, "modules"), { recursive: true })
	symlinkSync(HONEST_MOD_FIXTURE, join(scratch, "modules", "honest-mod"))
	return scratch
}

interface TreeEntry {
	path: string
	hash: string
}

function snapshotTree(root: string): TreeEntry[] {
	const entries: TreeEntry[] = []
	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name)
			const rel = relative(root, full)
			if (entry.isDirectory()) {
				walk(full)
			} else if (entry.isFile()) {
				const hash = createHash("sha256").update(readFileSync(full)).digest("hex")
				entries.push({ path: rel, hash })
			}
		}
	}
	if (existsSync(root)) walk(root)
	entries.sort((a, b) => a.path.localeCompare(b.path))
	return entries
}

function treeDiff(
	before: TreeEntry[],
	after: TreeEntry[],
	ignore?: (relPath: string) => boolean,
): { added: TreeEntry[]; removed: TreeEntry[]; changed: { before: TreeEntry; after: TreeEntry }[] } {
	const byPathBefore = new Map(before.map((e) => [e.path, e]))
	const byPathAfter = new Map(after.map((e) => [e.path, e]))
	const added: TreeEntry[] = []
	const removed: TreeEntry[] = []
	const changed: { before: TreeEntry; after: TreeEntry }[] = []
	for (const [path, afterEntry] of byPathAfter) {
		if (ignore?.(path)) continue
		const beforeEntry = byPathBefore.get(path)
		if (!beforeEntry) added.push(afterEntry)
		else if (beforeEntry.hash !== afterEntry.hash) changed.push({ before: beforeEntry, after: afterEntry })
	}
	for (const [path, beforeEntry] of byPathBefore) {
		if (ignore?.(path)) continue
		if (!byPathAfter.has(path)) removed.push(beforeEntry)
	}
	return { added, removed, changed }
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/")
}

function isOnlyPlanFile(path: string): boolean {
	const normalized = normalizePath(path)
	return normalized.startsWith(".baka/plans/") && normalized.endsWith(".plan.json")
}

// ---------------------------------------------------------------------------
// Test fixture prep
// ---------------------------------------------------------------------------

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
// VAL-FOUND-001 / VAL-FOUND-002  plan never mutates the tree
// ---------------------------------------------------------------------------

describe("VAL-FOUND-001/002 plan never mutates the project tree", () => {
	it("leaves the tree byte-identical with and without --dry-run", async () => {
		for (const dryRunFlag of [[], ["--dry-run"]]) {
			const scratch = prepareScratchWithFixture("baka-plan-honesty-")
			const home = trackDir(makeEmptyDir("baka-plan-honesty-home-"))
			const llm = await startFakeLLM(planResponse())
			seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

			try {
				const before = snapshotTree(scratch)
				const { code, stdout, stderr } = await spawnCli(
					["--cwd", scratch, "plan", "write a marker", "--json", ...dryRunFlag],
					scratch,
					{ HOME: home },
					60_000,
				)

				expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)
				const parsed = JSON.parse(stdout) as { status: string; steps: unknown[]; logs: string[] }
				expect(parsed.status).toBe("SUCCESS")
				expect(parsed.steps.length).toBeGreaterThan(0)
				expect(llm.calls).toBeGreaterThanOrEqual(1)

				const after = snapshotTree(scratch)
				const diff = treeDiff(before, after)
				expect(diff.added, `plan mutated the tree: added ${JSON.stringify(diff.added)}`).toEqual([])
				expect(diff.removed, `plan mutated the tree: removed ${JSON.stringify(diff.removed)}`).toEqual([])
				expect(diff.changed, `plan mutated the tree: changed ${JSON.stringify(diff.changed)}`).toEqual([])
			} finally {
				await llm.close()
			}
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-005  plan --save persists a loadable plan
// ---------------------------------------------------------------------------

describe("VAL-FOUND-005 plan --save persists a loadable plan", () => {
	it("writes exactly one .baka/plans/*.plan.json and leaves the rest of the tree unchanged", async () => {
		const scratch = prepareScratchWithFixture("baka-plan-save-")
		const home = trackDir(makeEmptyDir("baka-plan-save-home-"))
		const llm = await startFakeLLM(planResponse())
		seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

		try {
			const before = snapshotTree(scratch)
			const { code, stdout, stderr } = await spawnCli(
				["--cwd", scratch, "plan", "write a marker", "--save", "--json"],
				scratch,
				{ HOME: home },
				60_000,
			)

			expect(code, `unexpected exit ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(0)
			const parsed = JSON.parse(stdout) as { status: string; steps: unknown[]; planFile?: string; savedAt?: string }
			expect(parsed.status).toBe("SUCCESS")
			expect(parsed.steps.length).toBeGreaterThan(0)
			expect(typeof parsed.planFile).toBe("string")
			expect(typeof parsed.savedAt).toBe("string")

			const planFile = parsed.planFile as string
			expect(existsSync(planFile), `plan file not written at ${planFile}`).toBe(true)
			const saved = JSON.parse(readFileSync(planFile, "utf-8")) as {
				resolvedSteps: unknown[]
				meta?: { intent: string }
			}
			expect(saved.resolvedSteps).toEqual(parsed.steps)
			expect(saved.meta?.intent).toBe("write a marker")

			const after = snapshotTree(scratch)
			const diff = treeDiff(before, after, isOnlyPlanFile)
			expect(diff.added, `unexpected extra files: ${JSON.stringify(diff.added)}`).toEqual([])
			expect(diff.removed, `files removed during save: ${JSON.stringify(diff.removed)}`).toEqual([])
			expect(diff.changed, `files changed during save: ${JSON.stringify(diff.changed)}`).toEqual([])

			const plansDir = join(scratch, ".baka", "plans")
			const planFiles = readdirSync(plansDir).filter((f) => f.endsWith(".plan.json"))
			expect(planFiles.length).toBe(1)
		} finally {
			await llm.close()
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-007  apply executes the saved plan
// ---------------------------------------------------------------------------

describe("VAL-FOUND-007 apply executes a saved plan", () => {
	it("runs the saved plan through the SAGA and produces the step's output files", async () => {
		const scratch = prepareScratchWithFixture("baka-plan-apply-")
		const home = trackDir(makeEmptyDir("baka-plan-apply-home-"))
		const llm = await startFakeLLM(planResponse())
		seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

		try {
			const save = await spawnCli(
				["--cwd", scratch, "plan", "write a marker", "--save", "--json"],
				scratch,
				{ HOME: home },
				60_000,
			)
			expect(save.code, `save failed: ${save.stderr}`).toBe(0)
			const saved = JSON.parse(save.stdout) as { planFile?: string }
			expect(typeof saved.planFile).toBe("string")
			const planFile = saved.planFile as string

			const apply = await spawnCli(["--cwd", scratch, "apply", planFile, "--json"], scratch, { HOME: home }, 60_000)
			expect(apply.code, `unexpected apply exit ${apply.code}; stderr=${apply.stderr}`).toBe(0)
			const parsed = JSON.parse(apply.stdout) as {
				status: string
				completedSteps: Array<{ module: string; action: string }>
			}
			expect(parsed.status).toBe("SUCCESS")
			expect(parsed.completedSteps.length).toBeGreaterThan(0)
			expect(parsed.completedSteps[0]).toMatchObject({ module: "honest-mod", action: "write" })
			expect(existsSync(join(scratch, "marker.txt"))).toBe(true)
		} finally {
			await llm.close()
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-010  no dead --execute branch
// ---------------------------------------------------------------------------

describe("VAL-FOUND-010 no dead --execute branch in baka plan", () => {
	it("does not advertise --execute in --help and rejects it as an unknown option", async () => {
		const { code: helpCode, stdout: helpOut, stderr: helpErr } = await spawnCli(["plan", "--help"], BAKA_REPO)
		expect(helpCode, `help failed: ${helpErr}`).toBe(0)
		expect(helpOut).toContain("--dry-run")
		expect(helpOut).toContain("--save")
		expect(helpOut).toContain("--json")
		expect(helpOut).not.toContain("--execute")

		const home = trackDir(makeEmptyDir("baka-plan-execute-home-"))
		const llm = await startFakeLLM(planResponse())
		seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

		try {
			const { code, stderr } = await spawnCli(["plan", "x", "--execute"], BAKA_REPO, { HOME: home }, 60_000)
			expect(code, `expected non-zero exit, got ${code}`).not.toBe(0)
			expect(stderr.toLowerCase()).toMatch(/unknown option|error: unknown option/)
			expect(stderr).toContain("--execute")
		} finally {
			await llm.close()
		}
	}, 120_000)
})
