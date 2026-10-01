// ---------------------------------------------------------------------------
// Determinism e2e against the real local llama-server.
//
// Coverage map (validation-contract.md):
//   VAL-FOUND-027  Determinism e2e exists and is gated off by default
//   VAL-FOUND-028  Determinism e2e passes against local llama-server when opted in
//
// This suite is OPT-IN: it only runs when BAKA_E2E_LLM=1 is set. Without the
// flag the whole suite reports as skipped (vitest prints the suite name,
// which names the opt-in). With the flag, the suite plans the same intent 5
// times SEQUENTIALLY through the built CLI against the shared llama-server
// (pinned model gemma4:e4b, temperature 0, fixed seed 42, generous
// max_tokens) and asserts all 5 plans are byte-identical, printing each
// plan's sha256.
//
// The llama-server is shared infrastructure: this suite NEVER starts,
// restarts, or kills it. When the server or the pinned model is unavailable
// the test skips (VAL-FOUND-028 prerequisite), it does not fail.
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const HONEST_MOD_FIXTURE = join(BAKA_REPO, "apps", "cli", "test", "fixtures", "honest-mod")
const SLOT_MOD_FIXTURE = join(BAKA_REPO, "apps", "cli", "test", "fixtures", "slot-mod")

const E2E_BASE_URL = process.env.BAKA_E2E_LLM_BASE_URL ?? "http://127.0.0.1:8080/v1"
const E2E_MODEL = "gemma4:e4b"
const E2E_SEED = 42
const E2E_RUNS = 5
const INTENT = "write a marker"

interface SpawnResult {
	code: number | null
	stdout: string
	stderr: string
}

function spawnCli(argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<SpawnResult> {
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

function seedRoleConfig(home: string): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify(
			{
				worker: {
					baseUrl: E2E_BASE_URL,
					model: E2E_MODEL,
					apiKey: "e2e-llama-local",
					temperature: 0,
					maxTokens: 8192,
					timeoutMs: 300_000,
					seed: E2E_SEED,
				},
			},
			null,
			2,
		),
	)
}

interface ServerProbe {
	reachable: boolean
	reason: string
}

async function probeLlamaServer(): Promise<ServerProbe> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 5_000)
	try {
		const res = await fetch(`${E2E_BASE_URL}/models`, { signal: controller.signal })
		if (!res.ok) {
			return { reachable: false, reason: `llama-server at ${E2E_BASE_URL} returned ${res.status}` }
		}
		const body = (await res.json()) as { data?: Array<{ id?: string; aliases?: string[] }> }
		const models = body.data ?? []
		const found = models.some((m) => m.id === E2E_MODEL || (m.aliases ?? []).includes(E2E_MODEL))
		if (!found) {
			return {
				reachable: false,
				reason: `model ${E2E_MODEL} is not served by ${E2E_BASE_URL} (served: ${models.map((m) => m.id).join(", ")})`,
			}
		}
		return { reachable: true, reason: "" }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return { reachable: false, reason: `llama-server not reachable at ${E2E_BASE_URL}: ${message}` }
	} finally {
		clearTimeout(timer)
	}
}

const createdDirs: string[] = []
function trackDir(path: string): string {
	createdDirs.push(path)
	return path
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	}
})

beforeAll(() => {
	if (process.env.BAKA_E2E_LLM !== "1") return
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
})

const optIn = process.env.BAKA_E2E_LLM === "1"
const describeIfOptIn = optIn ? describe : describe.skip
if (!optIn) {
	console.log(`[determinism-e2e] skipped; opt in with BAKA_E2E_LLM=1 to run against the local llama-server`)
}

describeIfOptIn(
	`determinism e2e (opt-in via BAKA_E2E_LLM=1; real llama-server, ${E2E_MODEL}, temp 0, seed ${E2E_SEED})`,
	() => {
		it(`produces byte-identical plans across ${E2E_RUNS} sequential runs`, async (ctx) => {
			const probe = await probeLlamaServer()
			if (!probe.reachable) {
				ctx.skip(`VAL-FOUND-028 prerequisite unmet: ${probe.reason}`)
			}

			const scratch = trackDir(mkdtempSync(join(tmpdir(), "baka-determinism-e2e-")))
			mkdirSync(join(scratch, "modules"), { recursive: true })
			symlinkSync(HONEST_MOD_FIXTURE, join(scratch, "modules", "honest-mod"))
			const home = trackDir(mkdtempSync(join(tmpdir(), "baka-determinism-e2e-home-")))
			seedRoleConfig(home)

			const planJsons: string[] = []
			const hashes: string[] = []
			// Sequential by construction: each plan awaits the previous one.
			// llama-server serves a single loaded model; parallel requests would
			// queue server-side anyway and would hammer shared infrastructure.
			for (let run = 1; run <= E2E_RUNS; run++) {
				const { code, stdout, stderr } = await spawnCli(
					["--cwd", scratch, "plan", INTENT, "--json"],
					scratch,
					{ HOME: home },
					300_000,
				)
				expect(code, `run ${run} plan failed; stdout=${stdout}; stderr=${stderr}`).toBe(0)
				const parsed = JSON.parse(stdout) as { status: string; steps: unknown[] }
				expect(parsed.status, `run ${run} plan status; logs=${JSON.stringify(parsed)}`).toBe("SUCCESS")
				expect(parsed.steps.length, `run ${run} produced an empty plan`).toBeGreaterThan(0)
				const stepsJson = JSON.stringify(parsed.steps)
				const hash = createHash("sha256").update(stepsJson).digest("hex")
				planJsons.push(stepsJson)
				hashes.push(hash)
				console.log(`[determinism-e2e] run ${run}/${E2E_RUNS} plan sha256: ${hash}`)
			}

			const distinct = new Set(planJsons)
			expect(
				distinct.size,
				`plans diverged across runs:\n${hashes.map((h, i) => `run ${i + 1}: ${h}`).join("\n")}\n${planJsons
					.map((j, i) => `run ${i + 1}: ${j}`)
					.join("\n")}`,
			).toBe(1)
			console.log(`[determinism-e2e] all ${E2E_RUNS} plans byte-identical: ${hashes[0]}`)
		}, 1_200_000)

		it(`produces byte-identical apply trees across 2 sequential runs of honest-mod/write`, async (ctx) => {
			const probe = await probeLlamaServer()
			if (!probe.reachable) {
				ctx.skip(`VAL-FOUND-028 prerequisite unmet: ${probe.reason}`)
			}

			const hashes: string[] = []
			for (let run = 1; run <= 2; run++) {
				const scratch = trackDir(mkdtempSync(join(tmpdir(), "baka-determinism-apply-")))
				mkdirSync(join(scratch, "modules"), { recursive: true })
				symlinkSync(HONEST_MOD_FIXTURE, join(scratch, "modules", "honest-mod"))
				const home = trackDir(mkdtempSync(join(tmpdir(), "baka-determinism-apply-home-")))
				seedRoleConfig(home)
				writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "probe", private: true }))
				const applied = await spawnCli(
					["--cwd", scratch, "run", "honest-mod/write", "--json"],
					scratch,
					{ HOME: home },
					300_000,
				)
				expect(applied.code, `run ${run} failed; stdout=${applied.stdout}; stderr=${applied.stderr}`).toBe(0)
				const marker = readFileSync(join(scratch, "marker.txt"), "utf-8")
				const hash = createHash("sha256").update(marker).digest("hex")
				hashes.push(hash)
				console.log(`[determinism-e2e] apply run ${run} tree sha256: ${hash}`)
			}
			expect(new Set(hashes).size, `apply trees diverged: ${hashes.join(" ")}`).toBe(1)
		}, 1_200_000)

		it(`produces byte-identical slot-mod trees across 2 sequential gemma4:e4b fills`, async (ctx) => {
			const probe = await probeLlamaServer()
			if (!probe.reachable) {
				ctx.skip(`VAL-FOUND-028 prerequisite unmet: ${probe.reason}`)
			}

			const hashes: string[] = []
			for (let run = 1; run <= 2; run++) {
				const scratch = trackDir(mkdtempSync(join(tmpdir(), "baka-determinism-slot-")))
				mkdirSync(join(scratch, "modules"), { recursive: true })
				symlinkSync(SLOT_MOD_FIXTURE, join(scratch, "modules", "slot-mod"))
				const home = trackDir(mkdtempSync(join(tmpdir(), "baka-determinism-slot-home-")))
				seedRoleConfig(home)
				writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "probe", private: true }))
				const applied = await spawnCli(
					["--cwd", scratch, "run", "slot-mod/write", "--title", "Probe", "--json"],
					scratch,
					{ HOME: home },
					300_000,
				)
				expect(applied.code, `slot-mod run ${run} failed; stdout=${applied.stdout}; stderr=${applied.stderr}`).toBe(0)
				const parsed = JSON.parse(applied.stdout) as { ok?: boolean; slots?: Array<{ id: string }> }
				expect(parsed.ok, `slot-mod run ${run} not ok: ${applied.stdout}`).toBe(true)
				const note = readFileSync(join(scratch, "note.md"), "utf-8")
				expect(note.startsWith("# Probe\n")).toBe(true)
				const hash = createHash("sha256").update(note).digest("hex")
				hashes.push(hash)
				console.log(`[determinism-e2e] slot-mod run ${run} tree sha256: ${hash}`)
			}
			expect(new Set(hashes).size, `slot-mod trees diverged: ${hashes.join(" ")}`).toBe(1)
		}, 1_200_000)
	},
)
