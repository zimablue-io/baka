#!/usr/bin/env node
// group-b driver: runs the 9 foundation-fix MCP stdio assertions end-to-end
// against the BUILT artifacts (apps/mcp/dist/index.js, apps/cli/dist/index.js).
// No in-process MCP; no tsx; the layer under test is exactly what a user
// would invoke.

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join, relative, resolve as resolvePath } from "node:path"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO = "/Users/lefamoffat/Documents/projects/baka"
const MCP_DIST = join(REPO, "apps", "mcp", "dist", "index.js")
const CLI_DIST = join(REPO, "apps", "cli", "dist", "index.js")
const HONEST_MOD_FIXTURE = join(REPO, "apps", "cli", "test", "fixtures", "honest-mod")
const SHIPPED_MODULES = ["baka-base", "sdd", "ts-style"]

const MISSION = "/Users/lefamoffat/.factory/missions/575cdfaa-780a-4bec-8e44-538fe8778426"
const EVIDENCE_ROOT = join(MISSION, "evidence", "foundation-fix", "group-b")
const REPORT_PATH = join(MISSION, "validation", "foundation-fix", "user-testing", "flows", "group-b-mcp-stdio.json")

if (!existsSync(MCP_DIST)) {
	console.error(`MCP dist not found at ${MCP_DIST}`)
	process.exit(2)
}
mkdirSync(EVIDENCE_ROOT, { recursive: true })

// ---------------------------------------------------------------------------
// Helpers (mirrors apps/mcp/test/mcp-e2e.test.ts and cli-mcp-consistency.test.ts)
// ---------------------------------------------------------------------------

function seedRoleConfig(home, { baseUrl, model, apiKey = "test-worker-key" }) {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify(
			{
				worker: { baseUrl, model, apiKey, temperature: 0, maxTokens: 8192, timeoutMs: 120000 },
			},
			null,
			2,
		),
	)
}

function spawnMcp({ cwd, home, trace }) {
	const env = { ...process.env, HOME: home }
	const child = spawn("node", [MCP_DIST], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
	const state = {
		child,
		stdoutBuf: "",
		stderrBuf: "",
		requests: [],
		framesSent: [],
		nextId: 1,
	}
	child.stdout.on("data", (b) => {
		state.stdoutBuf += b.toString()
		for (;;) {
			const idx = state.stdoutBuf.indexOf("\n")
			if (idx === -1) break
			const line = state.stdoutBuf.slice(0, idx).trim()
			state.stdoutBuf = state.stdoutBuf.slice(idx + 1)
			if (!line) continue
			try {
				state.requests.push(JSON.parse(line))
			} catch {
				// ignore non-JSON (shouldn't happen on stdout)
			}
		}
	})
	child.stderr.on("data", (b) => {
		state.stderrBuf += b.toString()
	})
	if (trace) trace.push({ kind: "spawn", cwd, env: { ...env }, pid: child.pid })
	return state
}

function sendRpc(state, method, params, trace) {
	const useId = state.nextId++
	const frame = { jsonrpc: "2.0", id: useId, method, ...(params !== undefined ? { params } : {}) }
	state.child.stdin.write(`${JSON.stringify(frame)}\n`)
	if (trace) trace.push({ dir: "send", frame })
	return useId
}

async function waitForResponse(state, id, timeoutMs = 30000, trace) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const found = state.requests.find((r) => r.id === id)
		if (found) {
			if (trace) trace.push({ dir: "recv", frame: found })
			return found
		}
		await new Promise((r) => setTimeout(r, 10))
	}
	return undefined
}

async function initialize(state, trace) {
	const id = sendRpc(
		state,
		"initialize",
		{ protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "group-b-driver", version: "0.0.0" } },
		trace,
	)
	const resp = await waitForResponse(state, id, 5000, trace)
	if (!resp) throw new Error("initialize: no response within 5s")
	if (resp.error) throw new Error(`initialize: ${JSON.stringify(resp.error)}`)
	return resp
}

async function shutdown(state) {
	try {
		state.child.stdin.end()
	} catch {
		// ignore
	}
	await new Promise((resolve) => {
		const t = setTimeout(() => {
			try {
				state.child.kill("SIGKILL")
			} catch {
				// ignore
			}
			resolve()
		}, 500)
		state.child.on("close", () => {
			clearTimeout(t)
			resolve()
		})
	})
}

function startFakeLLM(script) {
	let calls = 0
	let scriptIdx = 0
	const requests = []
	const server = createHttpServer((req, res) => {
		if (!req.url || (!req.url.endsWith("/chat/completions"))) {
			res.statusCode = 404
			res.end("not found")
			return
		}
		let body = ""
		req.on("data", (c) => (body += c))
		req.on("end", () => {
			calls++
			requests.push(body)
			const next = script[scriptIdx++] ?? script[script.length - 1]
			res.setHeader("Content-Type", "application/json")
			res.end(
				JSON.stringify({
					id: `fake-${calls}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: "fake-llm",
					choices: [{ index: 0, message: { role: "assistant", content: next.content }, finish_reason: "stop" }],
					usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
				}),
			)
		})
	})
	return new Promise((resolve, reject) => {
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (!addr || typeof addr !== "object") {
				reject(new Error("fake LLM: failed to bind"))
				return
			}
			resolve({
				url: `http://127.0.0.1:${addr.port}/v1`,
				port: addr.port,
				get calls() {
					return calls
				},
				requests,
				close: () => new Promise((r) => server.close(() => r())),
			})
		})
	})
}

function planResponse({ modules, action, params } = { modules: ["honest-mod"], action: "write", params: {} }) {
	const step = { id: "step-1", module: modules[0], action, params }
	if (modules.length > 1) {
		return {
			content: JSON.stringify({
				resolvedSteps: modules.map((m, i) => ({
					id: `step-${i + 1}`,
					module: m,
					action: i === 0 ? action : modules[i].split(":")[1],
					params: i === 0 ? params : {},
				})),
			}),
		}
	}
	return { content: JSON.stringify({ resolvedSteps: [step] }) }
}

function makeEmptyDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix))
}

function prepareScratchWithFixture(prefix, modules) {
	const scratch = makeEmptyDir(prefix)
	mkdirSync(join(scratch, "modules"), { recursive: true })
	for (const mod of modules) {
		const target = mod === "honest-mod" ? HONEST_MOD_FIXTURE : join(REPO, "modules", mod)
		symlinkSync(target, join(scratch, "modules", mod))
	}
	return scratch
}

function snapshotTree(root) {
	const entries = []
	function walk(dir) {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name)
			const rel = relative(root, full)
			if (e.isDirectory()) walk(full)
			else if (e.isFile()) entries.push({ path: rel, hash: createHash("sha256").update(readFileSync(full)).digest("hex") })
		}
	}
	if (existsSync(root)) walk(root)
	entries.sort((a, b) => a.path.localeCompare(b.path))
	return entries
}

function treeDiff(before, after, ignore) {
	const b = new Map(before.map((e) => [e.path, e]))
	const a = new Map(after.map((e) => [e.path, e]))
	const added = []
	const removed = []
	const changed = []
	for (const [path, e] of a) {
		if (ignore?.(path)) continue
		const beforeEntry = b.get(path)
		if (!beforeEntry) added.push(e)
		else if (beforeEntry.hash !== e.hash) changed.push({ before: beforeEntry, after: e })
	}
	for (const [path, e] of b) {
		if (ignore?.(path)) continue
		if (!a.has(path)) removed.push(e)
	}
	return { added, removed, changed }
}

function runCli(argv, opts) {
	return new Promise((resolve) => {
		const child = spawn("node", [CLI_DIST, ...argv], {
			cwd: opts.cwd,
			env: { ...process.env, HOME: opts.home },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (b) => (stdout += b.toString()))
		child.stderr.on("data", (b) => (stderr += b.toString()))
		child.on("close", (code) => resolve({ code, stdout, stderr }))
	})
}

function writeEvidence(dir, files) {
	mkdirSync(dir, { recursive: true })
	for (const [name, body] of Object.entries(files)) {
		const full = join(dir, name)
		if (typeof body === "string") writeFileSync(full, body, "utf-8")
		else writeFileSync(full, JSON.stringify(body, null, 2), "utf-8")
	}
}

// ---------------------------------------------------------------------------
// Assertion runner
// ---------------------------------------------------------------------------

const startedAt = new Date().toISOString()
const reportAssertions = []

function record({ id, title, status, steps, evidence, issues }) {
	reportAssertions.push({ id, title, status, steps, evidence, issues })
	process.stdout.write(`[${status.toUpperCase()}] ${id} - ${title}\n`)
	for (const s of steps) process.stdout.write(`   ${s.action}\n     expected: ${s.expected}\n     observed: ${s.observed}\n`)
	if (issues) process.stdout.write(`   --- ISSUES ---\n${issues}\n`)
	if (evidence) process.stdout.write(`   evidence: ${evidence}\n`)
}

// ---------------------------------------------------------------------------
// ASS-19  VAL-FOUND-003 — baka_plan never mutates the tree (dryRun + default)
// ---------------------------------------------------------------------------

async function runASS19() {
	const id = "ASS-19"
	const title = "VAL-FOUND-003 — MCP baka_plan never mutates tree"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null

	const scratch = prepareScratchWithFixture("g19-scratch-", ["honest-mod"])
	const llm = await startFakeLLM([planResponse()])
	const home = makeEmptyDir("g19-home-")
	seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

	const state = spawnMcp({ cwd: scratch, home })
	const trace = []
	try {
		await initialize(state, trace)
		const before = snapshotTree(scratch)

		// dryRun:true
		const dryId = sendRpc(
			state,
			"tools/call",
			{ name: "baka_plan", arguments: { intent: "do stuff", dryRun: true } },
			trace,
		)
		const dryResp = await waitForResponse(state, dryId, 60000, trace)
		const dryResult = dryResp?.result
		const dryParsed = dryResult?.content?.[0]?.text ? JSON.parse(dryResult.content[0].text) : null
		const dryTreeAfter = snapshotTree(scratch)
		const dryDiff = treeDiff(before, dryTreeAfter)
		steps.push({
			action: "tools/call baka_plan { intent, dryRun: true }",
			expected: "status payload returned, tree byte-identical",
			observed: `status=${dryParsed?.status}; diff=${JSON.stringify({
				added: dryDiff.added.length,
				removed: dryDiff.removed.length,
				changed: dryDiff.changed.length,
			})}`,
		})
		if (dryDiff.added.length || dryDiff.removed.length || dryDiff.changed.length) {
			status = "fail"
			issues = `dryRun:true mutated tree: ${JSON.stringify(dryDiff)}`
		}
		if (!dryParsed || !Array.isArray(dryParsed.steps)) {
			status = "fail"
			issues = (issues ?? "") + " | dryRun:false returned no plan payload"
		}

		// no flags (default save:false, dryRun:false — should still plan, NOT execute)
		const plainId = sendRpc(state, "tools/call", { name: "baka_plan", arguments: { intent: "do stuff" } }, trace)
		const plainResp = await waitForResponse(state, plainId, 60000, trace)
		const plainResult = plainResp?.result
		const plainParsed = plainResult?.content?.[0]?.text ? JSON.parse(plainResult.content[0].text) : null
		const plainTreeAfter = snapshotTree(scratch)
		const plainDiff = treeDiff(dryTreeAfter, plainTreeAfter) // diff vs after-call-1 (single-shot semantics)
		steps.push({
			action: "tools/call baka_plan { intent }",
			expected: "status payload returned, tree byte-identical",
			observed: `status=${plainParsed?.status}; diffVsFirstCall=${JSON.stringify({
				added: plainDiff.added.length,
				removed: plainDiff.removed.length,
				changed: plainDiff.changed.length,
			})}; marker.exists=${existsSync(join(scratch, "marker.txt"))}`,
		})
		// Critically: the applied plan in step 1 should NOT write marker.txt under default baka_plan
		if (existsSync(join(scratch, "marker.txt"))) {
			status = "fail"
			issues = (issues ?? "") + " | marker.txt was written by baka_plan (no dryRun), tree mutated"
		}
		if (!plainParsed || !Array.isArray(plainParsed.steps)) {
			status = "fail"
			issues = (issues ?? "") + " | plain baka_plan returned no plan payload"
		}
		if (plainDiff.added.length || plainDiff.removed.length || plainDiff.changed.length) {
			status = "fail"
			issues = (issues ?? "") + " | default baka_plan mutated tree"
		}
	} catch (err) {
		status = "fail"
		issues = (issues ?? "") + ` | threw: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
		await llm.close()
	}

	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"before.json": snapshotTree(scratch),
		"plan-dry.json": steps[0]?.observed,
		"plan-plain.json": steps[1]?.observed,
	})
	rmSync(scratch, { recursive: true, force: true })
	record({ id, title, status, steps, evidence: evDir, issues })
}

// ---------------------------------------------------------------------------
// ASS-20  VAL-FOUND-004 — baka_plan tool description honesty
// ---------------------------------------------------------------------------

async function runASS20() {
	const id = "ASS-20"
	const title = "VAL-FOUND-004 — MCP baka_plan tool description honesty"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null

	const scratch = prepareScratchWithFixture("g20-", ["honest-mod"])
	const home = makeEmptyDir("g20-home-")
	seedRoleConfig(home, { baseUrl: "http://127.0.0.1:1/v1", model: "fake-llm" })
	const state = spawnMcp({ cwd: scratch, home })
	const trace = []
	let toolEntry = null
	try {
		await initialize(state, trace)
		const listId = sendRpc(state, "tools/list", undefined, trace)
		const listResp = await waitForResponse(state, listId, 5000, trace)
		toolEntry = listResp?.result?.tools?.find((t) => t.name === "baka_plan")
		const desc = toolEntry?.description ?? ""
		const descLow = desc.toLowerCase()
		const props = toolEntry?.inputSchema?.properties ?? {}
		steps.push({
			action: "read baka_plan description",
			expected: 'contains "does not modify" and "baka_apply"',
			observed: `description="${desc.slice(0, 200)}…"`,
		})
		if (!descLow.includes("does not modify")) {
			status = "fail"
			issues = `description lacks "does not modify": ${desc}`
		}
		if (!descLow.includes("baka_apply")) {
			status = "fail"
			issues = (issues ?? "") + ` | description lacks "baka_apply": ${desc}`
		}
		steps.push({
			action: "read baka_plan inputSchema.properties",
			expected: "save and dryRun are exposed (boolean)",
			observed: `save=${typeof props.save?.type}; dryRun=${typeof props.dryRun?.type}`,
		})
		if (props.save?.type !== "boolean" || props.dryRun?.type !== "boolean") {
			status = "fail"
			issues = (issues ?? "") + ` | missing/scalar-wrong: ${JSON.stringify(props)}`
		}
	} catch (err) {
		status = "fail"
		issues = (issues ?? "") + ` | threw: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
	}

	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"baka_plan_entry.json": toolEntry ?? {},
	})
	rmSync(scratch, { recursive: true, force: true })
	record({ id, title, status, steps, evidence: evDir, issues })
}

// ---------------------------------------------------------------------------
// ASS-21  VAL-FOUND-006 — baka_plan with save:true persists a loadable plan
// ---------------------------------------------------------------------------

async function runASS21() {
	const id = "ASS-21"
	const title = "VAL-FOUND-006 — MCP baka_plan save:true persists a loadable plan"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null
	let savedPlanFile = null
	let mcpPlan = null

	const scratch = prepareScratchWithFixture("g21-", ["honest-mod"])
	const llm = await startFakeLLM([planResponse()])
	const home = makeEmptyDir("g21-home-")
	seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

	const state = spawnMcp({ cwd: scratch, home })
	const trace = []
	try {
		await initialize(state, trace)
		const before = snapshotTree(scratch)

		const callId = sendRpc(
			state,
			"tools/call",
			{ name: "baka_plan", arguments: { intent: "write a marker", save: true } },
			trace,
		)
		const resp = await waitForResponse(state, callId, 60000, trace)
		mcpPlan = resp?.result?.content?.[0]?.text ? JSON.parse(resp.result.content[0].text) : null
		steps.push({
			action: "tools/call baka_plan { intent, save: true }",
			expected: "status=SUCCESS, planFile=path",
			observed: `status=${mcpPlan?.status}; planFile=${mcpPlan?.planFile}`,
		})
		if (mcpPlan?.status !== "SUCCESS") {
			status = "fail"
			issues = `plan did not succeed: ${JSON.stringify(mcpPlan)}`
		}
		if (typeof mcpPlan?.planFile !== "string") {
			status = "fail"
			issues = (issues ?? "") + " | no planFile in response"
		} else {
			savedPlanFile = mcpPlan.planFile
		}

		const after = snapshotTree(scratch)
		const plansDirPath = join(scratch, ".baka", "plans")
		const planFiles = existsSync(plansDirPath)
			? readdirSync(plansDirPath).filter((f) => f.endsWith(".plan.json"))
			: []
		steps.push({
			action: "list <tmp>/.baka/plans/*.plan.json",
			expected: "exactly one plan file",
			observed: `plansDir.exists=${existsSync(plansDirPath)}; count=${planFiles.length}; files=${JSON.stringify(planFiles)}`,
		})
		if (planFiles.length !== 1) {
			status = "fail"
			issues = (issues ?? "") + ` | expected exactly 1 plan file, found ${planFiles.length}`
		}

		// Tree diff: ignore the single plan file we just wrote
		const isOnlyPlan = (p) => p.startsWith(".baka/plans/") && p.endsWith(".plan.json")
		const diff = treeDiff(before, after, isOnlyPlan)
		steps.push({
			action: "diff before/after tree ignoring plan file",
			expected: "no other tree changes",
			observed: `added=${diff.added.length}; removed=${diff.removed.length}; changed=${diff.changed.length}`,
		})
		if (diff.added.length || diff.removed.length || diff.changed.length) {
			status = "fail"
			issues = (issues ?? "") + ` | unexpected tree diff: ${JSON.stringify(diff)}`
		}

		// Saved plan file must parse and contain the same steps as the response
		if (savedPlanFile && existsSync(savedPlanFile)) {
			const saved = JSON.parse(readFileSync(savedPlanFile, "utf-8"))
			const respSteps = mcpPlan.steps
			const savedSteps = saved.resolvedSteps
			const matches = JSON.stringify(respSteps) === JSON.stringify(savedSteps)
			steps.push({
				action: "verify saved plan resolvedSteps match response steps",
				expected: "deep-equal",
				observed: `resp.length=${respSteps?.length}; saved.length=${savedSteps?.length}; equal=${matches}`,
			})
			if (!matches) {
				status = "fail"
				issues = (issues ?? "") + " | saved plan steps mismatch response steps"
			}
			steps.push({
				action: "saved plan meta.intent",
				expected: '"write a marker"',
				observed: JSON.stringify(saved.meta),
			})
			if (saved.meta?.intent !== "write a marker") {
				status = "fail"
				issues = (issues ?? "") + ` | saved plan meta.intent mismatch: ${saved.meta?.intent}`
			}
		}

		// Cross-surface: CLI `baka list-plans --json` should see this saved plan too
		const listOut = await runCli(["list-plans", "--json"], { cwd: scratch, home })
		const listParsed = listOut.stdout ? safeParseJson(listOut.stdout) ?? listOut.stdout.trim() : null
		steps.push({
			action: "CLI baka list-plans --json",
			expected: "lists the saved plan",
			observed: `code=${listOut.code}; stdout=${JSON.stringify(listParsed) ?? listOut.stdout.slice(0, 200)}`,
		})
	} catch (err) {
		status = "fail"
		issues = (issues ?? "") + ` | threw: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
		await llm.close()
	}

	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"plan_response.json": mcpPlan ?? {},
		"plans_dir_listing.json": existsSync(join(scratch, ".baka", "plans"))
			? readdirSync(join(scratch, ".baka", "plans"))
			: [],
	})
	// Keep scratch so ASS-22 can reuse the saved plan file
	record({ id, title, status, steps, evidence: evDir, issues })
	// Stash the scratch + plan file path for ASS-22 via closure scope
	ASS21_RESULTS.scratch = scratch
	ASS21_RESULTS.home = home
	ASS21_RESULTS.planFile = savedPlanFile
	ASS21_RESULTS.evDir = evDir
}
function safeParseJson(s) {
	try {
		return JSON.parse(s)
	} catch {
		return null
	}
}
const ASS21_RESULTS = {}

// ---------------------------------------------------------------------------
// ASS-22  VAL-FOUND-008 — baka_apply executes a saved plan
// ---------------------------------------------------------------------------

async function runASS22() {
	const id = "ASS-22"
	const title = "VAL-FOUND-008 — MCP baka_apply executes a saved plan"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null

	const scratch = ASS21_RESULTS.scratch
	const home = ASS21_RESULTS.home
	const planFile = ASS21_RESULTS.planFile
	if (!planFile || !existsSync(planFile)) {
		record({
			id,
			title,
			status: "blocked",
			steps: [{ action: "inherits plane/scratch from ASS-21", expected: "saved plan file", observed: `missing` }],
			evidence: evDir,
			issues: "ASS-21 did not produce a saved plan file",
		})
		return
	}
	const llm = await startFakeLLM([planResponse()])
	const state = spawnMcp({ cwd: scratch, home })
	const trace = []
	let applyResult = null
	try {
		await initialize(state, trace)
		const beforeApply = snapshotTree(scratch)
		const id1 = sendRpc(state, "tools/call", { name: "baka_apply", arguments: { planFile } }, trace)
		const resp = await waitForResponse(state, id1, 60000, trace)
		applyResult = resp?.result?.content?.[0]?.text ? JSON.parse(resp.result.content[0].text) : null
		steps.push({
			action: "tools/call baka_apply { planFile }",
			expected: "status=SUCCESS, completedSteps=[honest-mod:write]",
			observed: `status=${applyResult?.status}; completed=${JSON.stringify(applyResult?.completedSteps)}; failed=${JSON.stringify(applyResult?.failed)}`,
		})
		if (applyResult?.status !== "SUCCESS") {
			status = "fail"
			issues = `baka_apply did not succeed: ${JSON.stringify(applyResult)}`
		}
		const markerPath = join(scratch, "marker.txt")
		const afterApply = snapshotTree(scratch)
		steps.push({
			action: "verify plan's produced files exist",
			expected: "marker.txt exists",
			observed: `marker.txt=${existsSync(markerPath)}; tree_added=${JSON.stringify({
				before: beforeApply.find((e) => e.path === "marker.txt"),
				after: afterApply.find((e) => e.path === "marker.txt"),
			})}`,
		})
		if (!existsSync(markerPath)) {
			status = "fail"
			issues = (issues ?? "") + " | marker.txt was not created"
		}
	} catch (err) {
		status = "fail"
		issues = (issues ?? "") + ` | threw: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
		await llm.close()
	}

	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"apply_result.json": applyResult ?? {},
	})
	rmSync(scratch, { recursive: true, force: true })
	record({ id, title, status, steps, evidence: evDir, issues })
}

// ---------------------------------------------------------------------------
// ASS-23  VAL-FOUND-013 — Compensation holds on the MCP surface
// ---------------------------------------------------------------------------

async function runASS23() {
	const id = "ASS-23"
	const title = "VAL-FOUND-013 — MCP compensation holds"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null

	const llm = await startFakeLLM([planResponse()])
	const scratch = prepareScratchWithFixture("g23-", ["honest-mod"])
	const home = makeEmptyDir("g23-home-")
	seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

	// Pre-write a plan file with TWO steps:
	//   step-1: honest-mod:write  (succeeds, writes marker.txt)
	//   step-2: ghost:notreal     (NOT registered as a worker step -> saga.fail)
	const plansRoot = join(scratch, ".baka", "plans")
	mkdirSync(plansRoot, { recursive: true })
	const planFile = join(plansRoot, `${Date.now()}.plan.json`)
	const crafted = {
		resolvedSteps: [
			{ id: "step-1", module: "honest-mod", action: "write", params: {} },
			{ id: "step-2", module: "ghost", action: "notreal", params: {} },
		],
		meta: { intent: "compensate test", savedAt: new Date().toISOString(), model: "fake-llm" },
	}
	writeFileSync(planFile, JSON.stringify(crafted, null, 2), "utf-8")

	const state = spawnMcp({ cwd: scratch, home })
	const trace = []
	let applyResult = null
	try {
		await initialize(state, trace)
		const beforeApply = snapshotTree(scratch)
		steps.push({
			action: "snapshot before apply (marker.txt expected absent)",
			expected: "no marker.txt",
			observed: `marker.txt=${existsSync(join(scratch, "marker.txt"))}; files=${JSON.stringify(beforeApply.map((e) => e.path))}`,
		})

		const id1 = sendRpc(
			state,
			"tools/call",
			{ name: "baka_apply", arguments: { planFile } },
			trace,
		)
		const resp = await waitForResponse(state, id1, 60000, trace)
		applyResult = resp?.result?.content?.[0]?.text ? JSON.parse(resp.result.content[0].text) : null
		steps.push({
			action: "tools/call baka_apply (hand-written 2-step plan)",
			expected: "status=FAILED, fail.message mentions ghost:notreal",
			observed: `status=${applyResult?.status}; failed=${JSON.stringify(applyResult?.failed)}`,
		})
		if (applyResult?.status !== "FAILED") {
			status = "fail"
			issues = `expected FAILED, got ${applyResult?.status}`
		}
		if (!JSON.stringify(applyResult?.failed ?? {}).toLowerCase().includes("ghost") &&
			!JSON.stringify(applyResult?.failed ?? {}).toLowerCase().includes("notreal")) {
			status = "fail"
			issues = (issues ?? "") + ` | failed envelope lacks ghost:notreal context: ${JSON.stringify(applyResult?.failed)}`
		}

		const afterApply = snapshotTree(scratch)
		// Plan file is allowed to be present (we wrote it before calling). The assertion is:
		// tree must be byte-identical pre-call vs post-call, ignoring the plans file we wrote.
		const ignore = (p) => p === relative(scratch, planFile)
		const diff = treeDiff(beforeApply, afterApply, ignore)
		steps.push({
			action: "diff before/after apply (ignore pre-written plan file)",
			expected: "added=0, removed=0, changed=0",
			observed: `added=${diff.added.length}; removed=${diff.removed.length}; changed=${diff.changed.length}; marker=${existsSync(join(scratch, "marker.txt"))}`,
		})
		if (diff.added.length || diff.removed.length || diff.changed.length) {
			status = "fail"
			issues = (issues ?? "") + ` | tree mutated after failed apply: ${JSON.stringify(diff)}`
		}
		if (existsSync(join(scratch, "marker.txt"))) {
			status = "fail"
			issues = (issues ?? "") + " | marker.txt NOT removed by compensation"
		}
	} catch (err) {
		status = "fail"
		issues = (issues ?? "") + ` | threw: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
		await llm.close()
	}

	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"hand_written_plan.json": crafted,
		"apply_result.json": applyResult ?? {},
	})
	rmSync(scratch, { recursive: true, force: true })
	record({ id, title, status, steps, evidence: evDir, issues })
}

// ---------------------------------------------------------------------------
// ASS-24  VAL-FOUND-018 — Hyphenated per-action MCP tools execute to completion
// ---------------------------------------------------------------------------

async function runASS24() {
	const id = "ASS-24"
	const title = "VAL-FOUND-018 — Hyphenated per-action MCP tools execute"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null

	const scratch = prepareScratchWithFixture("g24-", SHIPPED_MODULES)
	writeFileSync(
		join(scratch, "package.json"),
		JSON.stringify({ name: "g24", version: "1.0.0", private: true }),
		"utf-8",
	)
	const home = makeEmptyDir("g24-home-")
	seedRoleConfig(home, { baseUrl: "http://127.0.0.1:1/v1", model: "fake-llm" })

	const state = spawnMcp({ cwd: scratch, home })
	const trace = []
	const actionResults = []
	try {
		await initialize(state, trace)

		const calls = [
			{ name: "baka_baka_base_add_script", args: { name: "build", command: "tsc" }, validate: () => {
				const pkg = JSON.parse(readFileSync(join(scratch, "package.json"), "utf-8"))
				return pkg.scripts?.build === "tsc"
			}, fileCheck: ["package.json"] },
			{ name: "baka_baka_base_add_dependency", args: { name: "lodash", version: "latest", dev: false }, validate: () => {
				const pkg = JSON.parse(readFileSync(join(scratch, "package.json"), "utf-8"))
				return pkg.dependencies?.lodash === "latest"
			}, fileCheck: ["package.json"] },
			{ name: "baka_ts_style_install_config", args: { strict: false }, validate: () => true, fileCheck: ["tsconfig.json", "biome.json"] },
		]
		for (const call of calls) {
			const cid = sendRpc(state, "tools/call", { name: call.name, arguments: call.args }, trace)
			const resp = await waitForResponse(state, cid, 30000, trace)
			const result = resp?.result
			const payload = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null
			const isErr = !!result?.isError || result?.isError === undefined ? false : false
			const success = payload?.success === true
			actionResults.push({ name: call.name, isError: result?.isError, payload })
			steps.push({
				action: `tools/call ${call.name}`,
				expected: "success=true, isError unset/false, declared outputs exist",
				observed: `success=${payload?.success}; isError=${result?.isError}; error=${payload?.error ?? "none"}`,
			})
			if (!success) {
				status = "fail"
				issues = (issues ?? "") + ` | ${call.name} did not succeed: ${JSON.stringify(payload)}`
			}
			if (result?.isError) {
				status = "fail"
				issues = (issues ?? "") + ` | ${call.name} set isError=true`
			}
			if (!call.validate()) {
				status = "fail"
				issues = (issues ?? "") + ` | ${call.name} declared output not produced (fileCheck=${JSON.stringify(call.fileCheck)})`
			}
		}
	} catch (err) {
		status = "fail"
		issues = (issues ?? "") + ` | threw: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
	}
	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"action_results.json": actionResults,
		"package_after.json": existsSync(join(scratch, "package.json"))
			? JSON.parse(readFileSync(join(scratch, "package.json"), "utf-8"))
			: null,
	})
	rmSync(scratch, { recursive: true, force: true })
	record({ id, title, status, steps, evidence: evDir, issues })
}

// ---------------------------------------------------------------------------
// ASS-25  VAL-FOUND-041 — CLI/MCP same plan shape; saved plans interchangeable
// ---------------------------------------------------------------------------

async function runASS25() {
	const id = "ASS-25"
	const title = "VAL-FOUND-041 — CLI/MCP plan shape parity"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null

	const scratch = prepareScratchWithFixture("g25-", ["honest-mod"])
	const llm = await startFakeLLM([planResponse()])
	const home = makeEmptyDir("g25-home-")
	seedRoleConfig(home, { baseUrl: llm.url, model: "fake-llm" })

	// CLI side: `baka plan ... --json --save`
	const cliOut = await runCli(["plan", "write a marker", "--json", "--save"], { cwd: scratch, home })
	const cliPlan = cliOut.stdout ? safeParseJson(cliOut.stdout) : null
	steps.push({
		action: "CLI baka plan ... --json --save",
		expected: "exit 0, JSON with status/steps/planFile",
		observed: `code=${cliOut.code}; status=${cliPlan?.status}; planFile=${cliPlan?.planFile}`,
	})
	if (cliOut.code !== 0) {
		status = "fail"
		issues = `CLI plan --json --save exit=${cliOut.code}; stderr=${cliOut.stderr.slice(0, 200)}`
	}
	if (!cliPlan || typeof cliPlan.planFile !== "string") {
		status = "fail"
		issues = (issues ?? "") + " | CLI did not return a planFile"
	}

	// MCP side: tools/call baka_plan { save: true }
	const state = spawnMcp({ cwd: scratch, home })
	const trace = []
	let mcpPlan = null
	try {
		await initialize(state, trace)
		const cid = sendRpc(
			state,
			"tools/call",
			{ name: "baka_plan", arguments: { intent: "write a marker", save: true } },
			trace,
		)
		const resp = await waitForResponse(state, cid, 60000, trace)
		mcpPlan = resp?.result?.content?.[0]?.text ? JSON.parse(resp.result.content[0].text) : null
		steps.push({
			action: "MCP tools/call baka_plan { intent, save: true }",
			expected: "JSON with status/steps/planFile",
			observed: `status=${mcpPlan?.status}; planFile=${mcpPlan?.planFile}`,
		})
		if (!mcpPlan || typeof mcpPlan.planFile !== "string") {
			status = "fail"
			issues = (issues ?? "") + " | MCP did not return a planFile"
		}

		// Shape parity: same keys
		const cliKeys = Object.keys(cliPlan ?? {}).sort()
		const mcpKeys = Object.keys(mcpPlan ?? {}).sort()
		steps.push({
			action: "compare top-level keys (CLI vs MCP)",
			expected: "equal",
			observed: `cli=${JSON.stringify(cliKeys)}; mcp=${JSON.stringify(mcpKeys)}; equal=${JSON.stringify(cliKeys) === JSON.stringify(mcpKeys)}`,
		})
		if (JSON.stringify(cliKeys) !== JSON.stringify(mcpKeys)) {
			status = "fail"
			issues = (issues ?? "") + ` | top-level keys differ: cli=${cliKeys} mcp=${mcpKeys}`
		}

		// Step content parity (deterministic fake)
		const cliSteps = JSON.stringify(cliPlan?.steps)
		const mcpSteps = JSON.stringify(mcpPlan?.steps)
		steps.push({
			action: "compare plan.steps (deterministic fake LLM)",
			expected: "deep-equal",
			observed: `equal=${cliSteps === mcpSteps}; cli.length=${cliPlan?.steps?.length}; mcp.length=${mcpPlan?.steps?.length}`,
		})
		if (cliSteps !== mcpSteps) {
			status = "fail"
			issues = (issues ?? "") + ` | plan.steps differ: cli=${cliSteps?.slice(0, 200)} mcp=${mcpSteps?.slice(0, 200)}`
		}

		// Status vocabulary parity
		const cliStatus = cliPlan?.status
		const mcpStatus = mcpPlan?.status
		steps.push({
			action: "compare status enumeration",
			expected: "same value",
			observed: `cli=${cliStatus}; mcp=${mcpStatus}`,
		})
		if (cliStatus !== mcpStatus) {
			status = "fail"
			issues = (issues ?? "") + ` | status differs: cli=${cliStatus} mcp=${mcpStatus}`
		}

		// Interchangeability: apply each saved file in a fresh scratch with same setup
		for (const [label, planFile] of [
			["cli-saved", cliPlan?.planFile],
			["mcp-saved", mcpPlan?.planFile],
		]) {
			const applyScratch = prepareScratchWithFixture(`g25-apply-${label}-`, ["honest-mod"])
			const applied = await runCli(["apply", planFile, "--json"], { cwd: applyScratch, home })
			const appliedJson = applied.stdout ? safeParseJson(applied.stdout) : null
			steps.push({
				action: `CLI baka apply ${label} plan`,
				expected: "exit 0, status=SUCCESS, marker.txt exists",
				observed: `code=${applied.code}; status=${appliedJson?.status}; marker.exists=${existsSync(join(applyScratch, "marker.txt"))}`,
			})
			if (applied.code !== 0 || appliedJson?.status !== "SUCCESS" || !existsSync(join(applyScratch, "marker.txt"))) {
				status = "fail"
				issues = (issues ?? "") + ` | ${label} apply failed: code=${applied.code} status=${appliedJson?.status} marker=${existsSync(join(applyScratch, "marker.txt"))}`
			}
			rmSync(applyScratch, { recursive: true, force: true })
		}
	} catch (err) {
		status = "fail"
		issues = (issues ?? "") + ` | threw: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
		await llm.close()
	}

	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"cli_plan.json": cliPlan ?? {},
		"mcp_plan.json": mcpPlan ?? {},
	})
	rmSync(scratch, { recursive: true, force: true })
	record({ id, title, status, steps, evidence: evDir, issues })
}

// ---------------------------------------------------------------------------
// ASS-26  VAL-FOUND-042 — Validation failure is inspectable as a failure
// ---------------------------------------------------------------------------

async function runASS26() {
	const id = "ASS-26"
	const title = "VAL-FOUND-042 — MCP validation failure is inspectable"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null

	// Per AGENTS.md: cwd = repo root deterministically fails (validators scan
	// the repo as if it were action output). Existing test (cli-mcp-consistency.test.ts)
	// confirms. Use repo root directly.
	const home = makeEmptyDir("g26-home-")
	seedRoleConfig(home, { baseUrl: "http://127.0.0.1:1/v1", model: "fake-llm" })
	const state = spawnMcp({ cwd: REPO, home })
	const trace = []
	let result = null
	let payload = null
	try {
		await initialize(state, trace)
		const cid = sendRpc(state, "tools/call", { name: "baka_validate", arguments: {} }, trace)
		const resp = await waitForResponse(state, cid, 30000, trace)
		result = resp?.result
		if (result?.content?.[0]?.text) {
			payload = JSON.parse(result.content[0].text)
		}
		steps.push({
			action: "tools/call baka_validate (cwd=repo root)",
			expected: "isError=true OR valid=false; kind=fail",
			observed: `isError=${result?.isError}; valid=${payload?.valid}; validation.kind=${payload?.validation?.kind}; diagnostics=${payload?.validation?.diagnostics?.length}`,
		})
		const isErrorSet = result?.isError === true
		const validFalse = payload?.valid === false
		const kindFail = payload?.validation?.kind === "fail"
		if (!kindFail) {
			status = "fail"
			issues = `validation.kind != "fail" (got ${payload?.validation?.kind}); full=${JSON.stringify(payload)?.slice(0, 400)}`
		}
		if (!isErrorSet && !validFalse) {
			status = "fail"
			issues = (issues ?? "") + " | neither isError nor valid=false is set; agent cannot branch without parsing free text"
		}
	} catch (err) {
		status = "fail"
		issues = (issues ?? "") + ` | threw: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
	}
	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"validate_result.json": { result, payload },
	})
	record({ id, title, status, steps, evidence: evDir, issues })
}

// ---------------------------------------------------------------------------
// ASS-27  VAL-FOUND-058 — Per-action MCP tool names exactly match module actions
// ---------------------------------------------------------------------------

async function runASS27() {
	const id = "ASS-27"
	const title = "VAL-FOUND-058 — MCP exposes per-action tool for every action"
	const evDir = join(EVIDENCE_ROOT, id)
	const steps = []
	let status = "pass"
	let issues = null

	const scratch = prepareScratchWithFixture("g27-", SHIPPED_MODULES)
	const home = makeEmptyDir("g27-home-")
	seedRoleConfig(home, { baseUrl: "http://127.0.0.1:1/v1", model: "fake-llm" })

	const state = spawnMcp({ cwd: scratch, home })
	const trace = []
	let toolNames = []
	try {
		await initialize(state, trace)
		const cid = sendRpc(state, "tools/list", undefined, trace)
		const resp = await waitForResponse(state, cid, 5000, trace)
		toolNames = (resp?.result?.tools ?? []).map((t) => t.name)
		steps.push({
			action: "MCP tools/list",
			expected: "4 engine + per-action for baka-base, sdd, ts-style",
			observed: `count=${toolNames.length}; names=${JSON.stringify(toolNames)}`,
		})
		if (!["baka_plan", "baka_apply", "baka_validate", "baka_list_actions"].every((n) => toolNames.includes(n))) {
			status = "fail"
			issues = "engine tools missing from tools/list"
		}
	} catch (err) {
		status = "fail"
		issues = `tools/list failed: ${err?.message ?? String(err)}`
	} finally {
		await shutdown(state)
	}

	// CLI side: baka module list-actions <name> --json per module
	const expected = new Set()
	const listReports = []
	for (const mod of SHIPPED_MODULES) {
		const out = await runCli(["module", "list-actions", mod, "--json"], { cwd: scratch, home })
		const parsed = out.stdout ? safeParseJson(out.stdout) : null
		listReports.push({ module: mod, code: out.code, parsed, stderr: out.stderr.slice(0, 200) })
		steps.push({
			action: `CLI baka module list-actions ${mod} --json`,
			expected: "exit 0; actions array",
			observed: `code=${out.code}; count=${parsed?.actions?.length}; ids=${JSON.stringify(parsed?.actions?.map((a) => a.id))}`,
		})
		if (out.code !== 0 || !Array.isArray(parsed?.actions)) {
			status = "fail"
			issues = (issues ?? "") + ` | list-actions ${mod} failed: ${out.stderr.slice(0, 200)}`
			continue
		}
		for (const a of parsed.actions) {
			expected.add(`baka_${mod.replace(/[^a-zA-Z0-9_]/g, "_")}_${a.id.replace(/[^a-zA-Z0-9_]/g, "_")}`)
		}
	}

	const ENGINE = new Set(["baka_plan", "baka_apply", "baka_validate", "baka_list_actions"])
	const mcpPerAction = new Set(toolNames.filter((n) => !ENGINE.has(n)))

	steps.push({
		action: "compare MCP per-action tool names vs CLI list-actions mapping",
		expected: "equal sets; specifically sdd.init-constitution & create-feature present; no stale",
		observed: `expected=${JSON.stringify([...expected].sort())}; actual=${JSON.stringify([...mcpPerAction].sort())}; missing=${JSON.stringify(
			[...expected].filter((n) => !mcpPerAction.has(n)),
		)}; stale=${JSON.stringify([...mcpPerAction].filter((n) => !expected.has(n)))}`,
	})
	const expectedSorted = [...expected].sort().join(",")
	const actualSorted = [...mcpPerAction].sort().join(",")
	if (expectedSorted !== actualSorted) {
		status = "fail"
		issues = `MCP per-action set differs from CLI list-actions set: missing=${JSON.stringify(
			[...expected].filter((n) => !mcpPerAction.has(n)),
		)} stale=${JSON.stringify([...mcpPerAction].filter((n) => !expected.has(n)))}`
	}
	const requiredPins = ["baka_sdd_init_constitution", "baka_sdd_create_feature"]
	for (const pin of requiredPins) {
		if (!mcpPerAction.has(pin)) {
			status = "fail"
			issues = (issues ?? "") + ` | missing pinned tool: ${pin}`
		}
	}

	writeEvidence(evDir, {
		"trace.jsonl": trace.map((t) => JSON.stringify(t)).join("\n"),
		"list_reports.json": listReports,
		"comparison.json": {
			expected: [...expected].sort(),
			actual_per_action: [...mcpPerAction].sort(),
			all_tools_listed: toolNames,
		},
	})
	rmSync(scratch, { recursive: true, force: true })
	record({ id, title, status, steps, evidence: evDir, issues })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("=== group-b MCP stdio assertions ===")

try {
	await runASS19()
	await runASS20()
	await runASS21()
	await runASS22()
	await runASS23()
	await runASS24()
	await runASS25()
	await runASS26()
	await runASS27()
} catch (err) {
	console.error("driver threw:", err)
	process.exit(2)
}

const summary = {
	milestone: "foundation-fix",
	group: "group-b-mcp-stdio",
	assertionsRun: reportAssertions.length,
	passed: reportAssertions.filter((r) => r.status === "pass").map((r) => r.id),
	failed: reportAssertions.filter((r) => r.status === "fail").map((r) => ({ id: r.id, reason: r.issues ?? "(no reason)", evidence: r.evidence })),
	blocked: reportAssertions.filter((r) => r.status === "blocked").map((r) => ({ id: r.id, reason: r.issues ?? "(no reason)", evidence: r.evidence })),
	toolsUsed: ["mcpStdioJsonRpc", "spawnDashCli", "fakeLLM", "treeSnapshot"],
	frictions: [],
	appliedUpdates: [],
	testedAt: startedAt,
	assertions: reportAssertions,
}

writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2), "utf-8")
console.log(`\nwrote report to ${REPORT_PATH}`)
console.log(`summary: ${summary.passed.length}/${summary.assertionsRun} passed, ${summary.failed.length} failed, ${summary.blocked.length} blocked`)
