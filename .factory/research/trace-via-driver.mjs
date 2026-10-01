import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
	existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

const REPO = "/Users/lefamoffat/Documents/projects/baka"
const MCP_DIST = join(REPO, "apps", "mcp", "dist", "index.js")
const CLI_DIST = join(REPO, "apps", "cli", "dist", "index.js")
const HONEST_MOD_FIXTURE = join(REPO, "apps", "cli", "test", "fixtures", "honest-mod")

function seed(home, url) {
	mkdirSync(join(home, ".baka"), { recursive: true })
	writeFileSync(join(home, ".baka", "config.json"), JSON.stringify({
		worker: { baseUrl: url, model: "fake-llm", apiKey: "k", temperature: 0, maxTokens: 8192, timeoutMs: 120000 },
	}))
}

const scratch = mkdtempSync(join(tmpdir(), "trc-"))
mkdirSync(join(scratch, "modules"), { recursive: true })
symlinkSync(HONEST_MOD_FIXTURE, join(scratch, "modules", "honest-mod"))

const llm = createServer((req, res) => {
	let body = ""
	req.on("data", (c) => (body += c))
	req.on("end", () => {
		res.setHeader("Content-Type", "application/json")
		res.end(JSON.stringify({
			id: "1", object: "chat.completion", created: 0, model: "fake-llm",
			choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ resolvedSteps: [{ id: "step-1", module: "honest-mod", action: "write", params: {} }] }) }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}))
	})
})
await new Promise((r) => llm.listen(0, "127.0.0.1", r))
const port = llm.address().port
const url = `http://127.0.0.1:${port}/v1`

const home = mkdtempSync(join(tmpdir(), "trh-"))
seed(home, url)

const mcp = spawn("node", [MCP_DIST], { cwd: scratch, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] })
let out = ""
let err = ""
mcp.stdout.on("data", (b) => { out += b.toString(); console.log("[OUT]", b.toString().trim()) })
mcp.stderr.on("data", (b) => { err += b.toString(); console.log("[ERR]", b.toString().trim()) })

function send(method, params, id) {
	const f = { jsonrpc: "2.0", id, method, params }
	mcp.stdin.write(JSON.stringify(f) + "\n")
}

send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }, 1)
await new Promise((r) => setTimeout(r, 200))
send("tools/call", { name: "baka_plan", arguments: { intent: "do", save: true } }, 2)
await new Promise((r) => setTimeout(r, 3000))

// Read saved plan from MCP output (find planFile)
const m2 = out.match(/"planFile":\s*"([^"]+)"/)
const planFile = m2?.[1]
console.log("[*] planFile:", planFile)

if (planFile) {
	await new Promise((r) => setTimeout(r, 200))
	send("tools/call", { name: "baka_apply", arguments: { planFile } }, 3)
	await new Promise((r) => setTimeout(r, 5000))
	console.log("[*] marker.txt:", existsSync(join(scratch, "marker.txt")))
	console.log("[*] full stderr:\n", err)
}

mcp.kill("SIGKILL")
llm.close()
rmSync(scratch, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })

await new Promise((r) => setTimeout(r, 500))
