// `baka serve` hardening, against the built CLI binary:
//   - a non-loopback bind without a bearer token is refused at startup
//   - a token from the flag or BAKA_ENGINE_TOKEN lets a non-loopback bind start
//   - the served engine enforces the token and the project allow-list

import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")

const dirs: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL")
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function projectDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-serve-cli-"))
	dirs.push(dir)
	writeFileSync(join(dir, "package.json"), "{}")
	return dir
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const home = mkdtempSync(join(tmpdir(), "baka-serve-home-"))
	dirs.push(home)
	const base: NodeJS.ProcessEnv = { ...process.env, BAKA_HOME: home, HOME: home }
	delete base.BAKA_ENGINE_TOKEN
	delete base.BAKA_ENGINE_ALLOWED_ROOTS
	return { ...base, ...extra }
}

function runServe(
	args: string[],
	cwd: string,
	environment: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [DIST_INDEX, "serve", ...args], { cwd, env: environment })
		children.push(child)
		let stderr = ""
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk)
		})
		child.on("close", (code) => resolve({ code, stderr }))
	})
}

/** Start `baka serve` on an ephemeral-ish port and resolve once it prints its URL. */
function startServe(args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [DIST_INDEX, "serve", ...args], { cwd, env: environment })
		children.push(child)
		let stderr = ""
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk)
			const match = /baka serve: (http:\/\/\S+)/.exec(stderr)
			if (match?.[1]) resolve(match[1])
		})
		child.on("close", (code) => reject(new Error(`baka serve exited ${code}: ${stderr}`)))
	})
}

const port = () => String(20000 + Math.floor(Math.random() * 20000))

describe("baka serve hardening", () => {
	it("refuses to bind a non-loopback address without a token", async () => {
		const { code, stderr } = await runServe(["--host", "0.0.0.0", "--port", port()], projectDir(), env())
		expect(code).toBe(1)
		expect(stderr).toContain("not a loopback address")
		expect(stderr).toContain("BAKA_ENGINE_TOKEN")
	})

	it("starts on a non-loopback address with a token from the environment, and enforces it", async () => {
		const cwd = projectDir()
		const url = await startServe(
			["--host", "0.0.0.0", "--port", port()],
			cwd,
			env({ BAKA_ENGINE_TOKEN: "env-token-123" }),
		)
		const local = url.replace("0.0.0.0", "127.0.0.1")
		expect((await fetch(`${local}/v1/modules`)).status).toBe(401)
		expect((await fetch(`${local}/v1/modules`, { headers: { authorization: "Bearer env-token-123" } })).status).toBe(
			200,
		)
	})

	it("takes the token from --token, and refuses another project unless --allow-root permits it", async () => {
		const cwd = projectDir()
		const elsewhere = projectDir()
		const closed = await startServe(["--port", port(), "--token", "flag-token-1"], cwd, env())
		const headers = { authorization: "Bearer flag-token-1" }
		expect((await fetch(`${closed}/v1/modules?project=${encodeURIComponent(elsewhere)}`, { headers })).status).toBe(403)

		const open = await startServe(["--port", port(), "--allow-root", tmpdir()], cwd, env())
		expect((await fetch(`${open}/v1/modules?project=${encodeURIComponent(elsewhere)}`)).status).toBe(200)
	})
})
