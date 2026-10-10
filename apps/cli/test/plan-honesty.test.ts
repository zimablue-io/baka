// ---------------------------------------------------------------------------
// Foundation-fix tests for the plan/apply honesty contract.
//
// Every probe spawns the BUILT CLI (`apps/cli/dist/index.js`) as a subprocess
// against a temp project with a hermetic fake LLM. The tests assert that
// `baka plan` (with and without --dry-run) never mutates the project tree,
// that `--save` persists a loadable plan, and that `baka apply` is the only
// execution path. Additional coverage makes every failure mode honest and
// side-effect free: empty catalog, missing config, unreachable LLM, malformed
// output, hung LLM, unloadable plan files, and plans referencing uninstalled
// packs. A deterministic-planner test path proves byte-identical plan output.
//
// Coverage map (validation-contract.md):
//   VAL-FOUND-001  `baka plan` never mutates the project tree
//   VAL-FOUND-002  `baka plan --dry-run` never mutates the project tree
//   VAL-FOUND-005  `baka plan --save` persists a loadable plan
//   VAL-FOUND-007  `baka apply <plan-file>` executes a saved plan
//   VAL-FOUND-009  Empty-catalog plan fails honestly
//   VAL-FOUND-010  No dead `--execute` branch in `baka plan`
//   VAL-FOUND-046  `baka plan` with no roles configured fails honestly
//   VAL-FOUND-051  Unreachable LLM endpoint fails honestly
//   VAL-FOUND-052  Malformed LLM output fails honestly
//   VAL-FOUND-053  Hung LLM fails in bounded time
//   VAL-FOUND-057  Deterministic planner yields byte-identical plans
//   VAL-FOUND-059  `baka apply` rejects unloadable plan files
//   VAL-FOUND-060  `baka apply` rejects uninstalled packs without partial writes
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
// Inline fixture: minimal manifest + a single non-reasoning `write` recipe.
// Built into the scratch tree (no symlink to a separate fixture dir, no
// `baka-sdk` import path required) so the loader sees the pack just like
// any other on-disk pack.
const HONEST_MOD_NAME = "honest-mod"
const HONEST_MOD_MANIFEST = `// Inline fixture: see apps/cli/test/plan-honesty.test.ts
// for why this is inlined instead of loaded from a separate fixture file.
import type { PackManifest } from "baka-sdk"

export const Manifest: PackManifest = {
\tname: "${HONEST_MOD_NAME}",
\tversion: "0.0.0",
\tdescription: "Inline non-reasoning fixture used by plan-honesty tests.",
\tdependencies: [],
\tconflictsWith: [],
\trecipes: [
\t\t{
\t\t\tid: "write",
\t\t\tdescription: "Write a marker file to the project root.",
\t\t\trequiresReasoning: false,
\t\t\tfilePatterns: ["marker.txt"],
\t\t\tvalidators: [],
\t\t\tparams: [],
\t\t},
\t],
\tpackValidators: [],
}
`
const HONEST_MOD_RECIPE = `import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AgentRole, type StepResponse, type WorkflowStep } from "baka-sdk"

export const writeRecipe: WorkflowStep<Record<string, never>, boolean, { targetDirectory: string }> = {
\tname: "${HONEST_MOD_NAME}.write",
\trole: AgentRole.WORKER,

\texecute: async (_input, state): Promise<StepResponse<boolean, { targetDirectory: string }>> => {
\t\tconst targetDirectory = state.targetDirectory
\t\twriteFileSync(join(targetDirectory, "marker.txt"), "honest-mod was here\\n", "utf-8")
\t\treturn {
\t\t\tsuccess: true,
\t\t\toutput: true,
\t\t\tcompensationData: { targetDirectory },
\t\t}
\t},

\tcompensate: async (data): Promise<void> => {
\t\ttry {
\t\t\trmSync(join(data.targetDirectory, "marker.txt"), { force: true })
\t\t} catch {
\t\t\t// best effort
\t\t}
\t},
}
`

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
	timeoutMs?: number
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
			timeoutMs: worker.timeoutMs ?? 120_000,
		},
	}
	if (validator) {
		out.validator = {
			baseUrl: validator.baseUrl,
			model: validator.model,
			apiKey: validator.apiKey ?? "test-validator-key",
			temperature: 0,
			maxTokens: 8192,
			timeoutMs: validator.timeoutMs ?? 120_000,
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
	return startFakeLLMBehavior({ content })
}

interface FakeLLMBehavior {
	content?: string
	/** Return the raw string as the message content without wrapping it in a JSON envelope. */
	invalidJson?: boolean
	/** Return a syntactically valid JSON object that does not match the plan schema. */
	schemaInvalid?: boolean
	/** Accept the request but never respond (tests the timeout path). */
	hang?: boolean
}

function startFakeLLMBehavior(behavior: FakeLLMBehavior): Promise<FakeLLMHandle> {
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
			if (behavior.hang) {
				// Intentionally never respond so the timeout fires.
				return
			}
			res.setHeader("Content-Type", "application/json")
			let messageContent: string
			if (behavior.invalidJson) {
				messageContent = behavior.content ?? "not valid json {"
			} else if (behavior.schemaInvalid) {
				messageContent = JSON.stringify({ resolvedSteps: [{ pack: 123, recipe: true, params: "wrong" }] })
			} else {
				messageContent = behavior.content ?? "{}"
			}
			res.end(
				JSON.stringify({
					id: `fake-${calls}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: "fake-llm",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: messageContent },
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

/** Bind a port on 127.0.0.1 and then immediately close it, returning the port. */
function deadPort(): number {
	const server = createServer()
	server.listen(0, "127.0.0.1")
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	server.close()
	return port
}

function planResponse(): string {
	return JSON.stringify({
		resolvedSteps: [
			{
				id: "step-1",
				pack: "honest-mod",
				recipe: "write",
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

// Path to a fully self-contained copy of the built CLI placed outside the
// repo tree. Used by VAL-FOUND-009 to prove the bundled-scope walk-up finds
// nothing when the dist itself is not inside the repo.
let outsideCliDist: string | null = null
let outsideCliDir: string | null = null

async function copyCliOutsideRepo(): Promise<string> {
	const outside = makeEmptyDir("baka-cli-outside-")
	outsideCliDir = outside
	mkdirSync(join(outside, "dist"), { recursive: true })
	cpSync(DIST_INDEX, join(outside, "dist", "index.js"))
	writeFileSync(
		join(outside, "package.json"),
		JSON.stringify({
			name: "baka-copied",
			version: "0.1.0",
			type: "module",
			dependencies: {
				"@inquirer/prompts": "^8.5.2",
				commander: "^15.0.0",
				jiti: "^2.7.0",
			},
		}),
	)
	await new Promise<void>((resolve, reject) => {
		const child = spawn("npm", ["install", "--prefix", outside, "--silent"], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stderr = ""
		child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()))
		child.on("error", reject)
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`npm install for outside CLI failed (exit ${code}): ${stderr}`))
			else resolve()
		})
	})
	return join(outside, "dist", "index.js")
}

function spawnOutsideCli(
	argv: string[],
	cwd: string,
	env: Record<string, string> = {},
	timeoutMs = 30_000,
): Promise<SpawnResult> {
	if (!outsideCliDist) throw new Error("outside CLI not prepared")
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [outsideCliDist, ...argv], { cwd, env: { ...process.env, ...env } })
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

function prepareScratchWithFixture(prefix: string): string {
	const scratch = trackDir(makeEmptyDir(prefix))
	const modDir = join(scratch, "packs", HONEST_MOD_NAME)
	mkdirSync(join(modDir, "write"), { recursive: true })
	writeFileSync(join(modDir, "manifest.ts"), HONEST_MOD_MANIFEST, "utf-8")
	writeFileSync(join(modDir, "write", "recipe.ts"), HONEST_MOD_RECIPE, "utf-8")
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

afterAll(() => {
	if (outsideCliDir && existsSync(outsideCliDir)) {
		rmSync(outsideCliDir, { recursive: true, force: true })
		outsideCliDir = null
	}
})

beforeAll(async () => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	outsideCliDist = await copyCliOutsideRepo()
}, 120_000)

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
				completedSteps: Array<{ pack: string; recipe: string; output?: unknown }>
			}
			expect(parsed.status).toBe("SUCCESS")
			expect(parsed.completedSteps.length).toBeGreaterThan(0)
			expect(parsed.completedSteps[0]).toMatchObject({ pack: "honest-mod", recipe: "write" })
			// Rich-output propagation: every completed step carries the recipe's
			// output payload (the worker propagates `result.output`, not the
			// boolean `result.success`). honest-mod's write recipe returns the
			// boolean `true`; real recipes (e.g. lint) return LintReport objects.
			expect(parsed.completedSteps[0]).toHaveProperty("output")
			expect(parsed.completedSteps[0]?.output).toBe(true)
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

// ---------------------------------------------------------------------------
// VAL-FOUND-009  empty-catalog plan fails honestly
// ---------------------------------------------------------------------------

describe("VAL-FOUND-009 empty-catalog plan fails honestly", () => {
	it("exits non-zero with a no-packs message and changes nothing when the CLI is outside the repo tree", async () => {
		expect(outsideCliDist, "outside CLI was not prepared in beforeAll").toBeTruthy()

		const project = trackDir(makeEmptyDir("baka-empty-catalog-project-"))
		const home = trackDir(makeEmptyDir("baka-empty-catalog-home-"))
		// A valid worker config exists, but planning must fail before any LLM call
		// because the catalog is empty.
		seedRoleConfig(home, { baseUrl: "http://127.0.0.1:31999/v1", model: "fake" })

		const before = snapshotTree(project)
		const { code, stdout, stderr } = await spawnOutsideCli(
			["--cwd", project, "plan", "anything", "--json", "--save"],
			project,
			{ HOME: home },
			60_000,
		)

		expect(code, `expected non-zero exit, got ${code}; stdout=${stdout}; stderr=${stderr}`).not.toBe(0)
		const parsed = JSON.parse(stdout) as { status: string; steps: unknown[]; logs: string[] }
		expect(parsed.status).toBe("FAILED")
		expect(parsed.steps).toEqual([])
		expect(parsed.logs.some((line) => /no packs were discovered/i.test(line))).toBe(true)
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(existsSync(join(project, ".baka", "plans"))).toBe(false)

		const after = snapshotTree(project)
		const diff = treeDiff(before, after)
		expect(diff.added, `tree mutated: added ${JSON.stringify(diff.added)}`).toEqual([])
		expect(diff.removed, `tree mutated: removed ${JSON.stringify(diff.removed)}`).toEqual([])
		expect(diff.changed, `tree mutated: changed ${JSON.stringify(diff.changed)}`).toEqual([])
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-046  no roles configured
// ---------------------------------------------------------------------------

describe("VAL-FOUND-046 baka plan with no roles configured", () => {
	it("exits 1 with a missing-config message and writes nothing", async () => {
		const scratch = prepareScratchWithFixture("baka-plan-no-roles-")
		const home = trackDir(makeEmptyDir("baka-plan-no-roles-home-"))

		const before = snapshotTree(scratch)
		const { code, stdout, stderr } = await spawnCli(
			["--cwd", scratch, "plan", "scaffold a project", "--json", "--save"],
			scratch,
			{ HOME: home },
			60_000,
		)

		expect(code, `expected exit 1, got ${code}; stdout=${stdout}; stderr=${stderr}`).toBe(1)
		expect(stderr).toMatch(/missing LLM config/i)
		expect(stderr).toMatch(/baka init/i)
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(existsSync(join(scratch, ".baka", "plans"))).toBe(false)

		const after = snapshotTree(scratch)
		const diff = treeDiff(before, after)
		expect(diff.added, `tree mutated: added ${JSON.stringify(diff.added)}`).toEqual([])
		expect(diff.removed, `tree mutated: removed ${JSON.stringify(diff.removed)}`).toEqual([])
		expect(diff.changed, `tree mutated: changed ${JSON.stringify(diff.changed)}`).toEqual([])
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-051  unreachable LLM endpoint
// ---------------------------------------------------------------------------

describe("VAL-FOUND-051 baka plan with an unreachable LLM endpoint", () => {
	it("exits non-zero naming the URL and transport failure; no plan saved", async () => {
		const scratch = prepareScratchWithFixture("baka-plan-dead-llm-")
		const home = trackDir(makeEmptyDir("baka-plan-dead-llm-home-"))
		const port = deadPort()
		const baseUrl = `http://127.0.0.1:${port}/v1`
		seedRoleConfig(home, { baseUrl, model: "fake" })

		const before = snapshotTree(scratch)
		const { code, stdout, stderr } = await spawnCli(
			["--cwd", scratch, "plan", "write a marker", "--json", "--save"],
			scratch,
			{ HOME: home },
			60_000,
		)

		expect(code, `expected non-zero exit, got ${code}; stdout=${stdout}; stderr=${stderr}`).not.toBe(0)
		const parsed = JSON.parse(stdout) as { status: string; steps: unknown[]; logs: string[] }
		expect(parsed.status).toBe("FAILED")
		expect(parsed.steps).toEqual([])
		expect(parsed.logs.some((line) => line.includes(baseUrl) && /failed|timed out|fetch/i.test(line))).toBe(true)
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(existsSync(join(scratch, ".baka", "plans"))).toBe(false)

		const after = snapshotTree(scratch)
		const diff = treeDiff(before, after)
		expect(diff.added, `tree mutated: added ${JSON.stringify(diff.added)}`).toEqual([])
		expect(diff.removed, `tree mutated: removed ${JSON.stringify(diff.removed)}`).toEqual([])
		expect(diff.changed, `tree mutated: changed ${JSON.stringify(diff.changed)}`).toEqual([])
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-052  malformed LLM output
// ---------------------------------------------------------------------------

describe("VAL-FOUND-052 baka plan with malformed LLM output", () => {
	it("exits non-zero for invalid JSON and schema-invalid variants without saving a plan", async () => {
		for (const behavior of [
			{ label: "invalid JSON", invalidJson: true },
			{ label: "schema invalid", schemaInvalid: true },
		] as const) {
			const scratch = prepareScratchWithFixture(`baka-plan-malformed-${behavior.label.replace(/\s/g, "-")}-`)
			const home = trackDir(makeEmptyDir("baka-plan-malformed-home-"))
			const llm = await startFakeLLMBehavior(behavior)
			seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm", timeoutMs: 10_000 })

			try {
				const before = snapshotTree(scratch)
				const { code, stdout, stderr } = await spawnCli(
					["--cwd", scratch, "plan", "write a marker", "--json", "--save"],
					scratch,
					{ HOME: home },
					60_000,
				)

				expect(code, `expected non-zero exit for ${behavior.label}, got ${code}`).not.toBe(0)
				const parsed = JSON.parse(stdout) as { status: string; steps: unknown[]; logs: string[] }
				expect(parsed.status).toBe("FAILED")
				expect(parsed.steps).toEqual([])
				expect(
					parsed.logs.some(
						(line) =>
							/orchestrator failed/i.test(line) &&
							/invalid|parse|schema|Unexpected token|valid JSON|did not match/i.test(line),
					),
					`expected an invalid-LLM-output log for ${behavior.label}; logs=${JSON.stringify(parsed.logs)}`,
				).toBe(true)
				expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
				expect(existsSync(join(scratch, ".baka", "plans"))).toBe(false)

				const after = snapshotTree(scratch)
				const diff = treeDiff(before, after)
				expect(diff.added, `tree mutated: added ${JSON.stringify(diff.added)}`).toEqual([])
				expect(diff.removed, `tree mutated: removed ${JSON.stringify(diff.removed)}`).toEqual([])
				expect(diff.changed, `tree mutated: changed ${JSON.stringify(diff.changed)}`).toEqual([])
			} finally {
				await llm.close()
			}
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-053  hung LLM
// ---------------------------------------------------------------------------

describe("VAL-FOUND-053 baka plan with a hung LLM", () => {
	it("terminates on its own within the configured timeout and reports a timeout", async () => {
		const scratch = prepareScratchWithFixture("baka-plan-hung-llm-")
		const home = trackDir(makeEmptyDir("baka-plan-hung-llm-home-"))
		const llm = await startFakeLLMBehavior({ hang: true })
		const timeoutMs = 5_000
		seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm", timeoutMs })

		try {
			const before = snapshotTree(scratch)
			const start = Date.now()
			const { code, stdout, stderr } = await spawnCli(
				["--cwd", scratch, "plan", "write a marker", "--json"],
				scratch,
				{ HOME: home },
				timeoutMs + 10_000,
			)
			const elapsed = Date.now() - start

			expect(code, `expected non-zero exit, got ${code}; stdout=${stdout}; stderr=${stderr}`).not.toBe(0)
			expect(elapsed, `command hung too long: ${elapsed}ms`).toBeLessThan(timeoutMs + 5_000)
			const parsed = JSON.parse(stdout) as { status: string; steps: unknown[]; logs: string[] }
			expect(parsed.status).toBe("FAILED")
			expect(parsed.steps).toEqual([])
			expect(parsed.logs.some((line) => /timed out/i.test(line))).toBe(true)
			expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)

			const after = snapshotTree(scratch)
			const diff = treeDiff(before, after)
			expect(diff.added, `tree mutated: added ${JSON.stringify(diff.added)}`).toEqual([])
			expect(diff.removed, `tree mutated: removed ${JSON.stringify(diff.removed)}`).toEqual([])
			expect(diff.changed, `tree mutated: changed ${JSON.stringify(diff.changed)}`).toEqual([])
		} finally {
			await llm.close()
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-057  deterministic planner
// ---------------------------------------------------------------------------

describe("VAL-FOUND-057 deterministic planner yields byte-identical plans", () => {
	it("produces identical steps across repeated runs and saved plans", async () => {
		const scratch = prepareScratchWithFixture("baka-plan-deterministic-")
		const home = trackDir(makeEmptyDir("baka-plan-deterministic-home-"))
		const llm = await startFakeLLM(planResponse())
		seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

		try {
			const first = await spawnCli(
				["--cwd", scratch, "plan", "write a marker", "--json"],
				scratch,
				{ HOME: home },
				60_000,
			)
			expect(first.code, `first plan failed: ${first.stderr}`).toBe(0)
			const firstParsed = JSON.parse(first.stdout) as { status: string; steps: unknown[] }
			expect(firstParsed.status).toBe("SUCCESS")

			const second = await spawnCli(
				["--cwd", scratch, "plan", "write a marker", "--save"],
				scratch,
				{ HOME: home },
				60_000,
			)
			expect(second.code, `second plan failed: ${second.stderr}`).toBe(0)
			const savedFile = readdirSync(join(scratch, ".baka", "plans"))
				.filter((f) => f.endsWith(".plan.json"))
				.map((f) => join(scratch, ".baka", "plans", f))[0]
			expect(savedFile).toBeDefined()
			const saved = JSON.parse(readFileSync(savedFile, "utf-8")) as { resolvedSteps: unknown[] }

			const third = await spawnCli(
				["--cwd", scratch, "plan", "write a marker", "--json"],
				scratch,
				{ HOME: home },
				60_000,
			)
			expect(third.code, `third plan failed: ${third.stderr}`).toBe(0)
			const thirdParsed = JSON.parse(third.stdout) as { status: string; steps: unknown[] }
			expect(thirdParsed.status).toBe("SUCCESS")

			expect(firstParsed.steps).toEqual(saved.resolvedSteps)
			expect(firstParsed.steps).toEqual(thirdParsed.steps)
			expect(llm.calls).toBeGreaterThanOrEqual(3)
		} finally {
			await llm.close()
		}
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-059  apply rejects unloadable plan files
// ---------------------------------------------------------------------------

describe("VAL-FOUND-059 baka apply rejects unloadable plan files", () => {
	it("fails honestly for missing and invalid-JSON plans without touching the tree", async () => {
		const scratch = prepareScratchWithFixture("baka-apply-unloadable-")
		const home = trackDir(makeEmptyDir("baka-apply-unloadable-home-"))
		seedRoleConfig(home, { baseUrl: "http://127.0.0.1:31999/v1", model: "fake" })

		const before = snapshotTree(scratch)

		const missing = await spawnCli(
			["--cwd", scratch, "apply", ".baka/plans/does-not-exist.plan.json", "--json"],
			scratch,
			{ HOME: home },
			60_000,
		)
		expect(missing.code, `expected non-zero exit for missing plan, got ${missing.code}`).not.toBe(0)
		expect(missing.stderr).toMatch(/plan file not found/i)
		expect(missing.stderr).toContain("does-not-exist.plan.json")
		expect(missing.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)

		const invalidPlan = join(scratch, "invalid.plan.json")
		writeFileSync(invalidPlan, "{not valid json", "utf-8")
		const invalid = await spawnCli(["--cwd", scratch, "apply", invalidPlan, "--json"], scratch, { HOME: home }, 60_000)
		expect(invalid.code, `expected non-zero exit for invalid plan, got ${invalid.code}`).not.toBe(0)
		expect(invalid.stderr).toMatch(/plan file is malformed|expected property|unexpected token/i)
		expect(invalid.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)

		const after = snapshotTree(scratch)
		const diff = treeDiff(before, after, (p) => normalizePath(p) === "invalid.plan.json")
		expect(diff.added, `tree mutated: added ${JSON.stringify(diff.added)}`).toEqual([])
		expect(diff.removed, `tree mutated: removed ${JSON.stringify(diff.removed)}`).toEqual([])
		expect(diff.changed, `tree mutated: changed ${JSON.stringify(diff.changed)}`).toEqual([])
	}, 120_000)
})

// ---------------------------------------------------------------------------
// VAL-FOUND-060  apply rejects uninstalled packs without partial writes
// ---------------------------------------------------------------------------

describe("VAL-FOUND-060 baka apply rejects a plan referencing an uninstalled pack", () => {
	it("fails on the unresolved pack and leaves the tree byte-identical", async () => {
		const scratch = prepareScratchWithFixture("baka-apply-uninstalled-")
		const home = trackDir(makeEmptyDir("baka-apply-uninstalled-home-"))
		seedRoleConfig(home, { baseUrl: "http://127.0.0.1:31999/v1", model: "fake" })

		const planFile = join(scratch, "ghost.plan.json")
		writeFileSync(
			planFile,
			JSON.stringify({
				resolvedSteps: [
					{ id: "step-1", pack: "ghost-mod", recipe: "scaffold", params: {} },
					{ id: "step-2", pack: "honest-mod", recipe: "write", params: {} },
				],
				meta: { intent: "use a ghost pack", savedAt: new Date().toISOString() },
			}),
			"utf-8",
		)

		const before = snapshotTree(scratch)
		const { code, stdout, stderr } = await spawnCli(
			["--cwd", scratch, "apply", planFile, "--json"],
			scratch,
			{ HOME: home },
			60_000,
		)

		expect(code, `expected non-zero exit, got ${code}; stdout=${stdout}; stderr=${stderr}`).not.toBe(0)
		const parsed = JSON.parse(stdout) as { status: string; failed: { error: string } | null }
		expect(parsed.status).toBe("FAILED")
		expect(parsed.failed?.error).toMatch(/ghost-mod/i)
		expect(stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(existsSync(join(scratch, "marker.txt"))).toBe(false)

		const after = snapshotTree(scratch)
		const diff = treeDiff(before, after, (p) => normalizePath(p) === "ghost.plan.json")
		expect(diff.added, `tree mutated: added ${JSON.stringify(diff.added)}`).toEqual([])
		expect(diff.removed, `tree mutated: removed ${JSON.stringify(diff.removed)}`).toEqual([])
		expect(diff.changed, `tree mutated: changed ${JSON.stringify(diff.changed)}`).toEqual([])
	}, 120_000)
})
