// CLI happy-path e2e: discover a well-formed fixture module, inspect
// templates, fill a slot, write, validate, write again with the same bytes.
// One test among many — not a special product surface.

import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { copyPlatformFixtures } from "./helpers/copy-fixtures"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")

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
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
})

function spawnCli(
	argv: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<{
	code: number | null
	stdout: string
	stderr: string
}> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...argv], {
			cwd,
			env: { ...process.env, ...env },
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
			resolve({ code: null, stdout, stderr: `${stderr}\n[test: killed after 30s]` })
		}, 30_000)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr })
		})
	})
}

function isolatedEnv(home: string): Record<string, string> {
	return { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home }
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

describe("CLI happy path against a fixture module", () => {
	it("lists, inspects templates, fills, writes, validates, and repeats identically", async () => {
		const home = trackDir(mkdtempSync(join(tmpdir(), "baka-cli-hp-home-")))
		mkdirSync(join(home, ".baka"), { recursive: true })
		const project = trackDir(mkdtempSync(join(tmpdir(), "baka-cli-hp-proj-")))
		writeFileSync(join(project, "package.json"), JSON.stringify({ name: "hp-proj", private: true }))
		copyPlatformFixtures(project)

		const env = isolatedEnv(home)

		const listed = await spawnCli(["list-modules", "--json"], project, env)
		expect(listed.code, listed.stderr).toBe(0)
		const listPayload = JSON.parse(listed.stdout) as { modules: Array<{ name: string }> }
		expect(listPayload.modules.map((m) => m.name).sort()).toEqual(["honest-mod", "slot-mod"])

		const actions = await spawnCli(["module", "list-actions", "slot-mod", "--json"], project, env)
		expect(actions.code, actions.stderr).toBe(0)
		expect(actions.stdout).toContain('"id": "write"')

		const inspected = await spawnCli(["inspect", "slot-mod/write", "--json"], project, env)
		expect(inspected.code, inspected.stderr).toBe(0)
		const preview = JSON.parse(inspected.stdout) as {
			files: Array<{ rel: string; source: string }>
			slots: Array<{ id: string }>
			params: Array<{ name: string }>
		}
		expect(preview.params.some((p) => p.name === "title")).toBe(true)
		expect(preview.slots.some((s) => s.id === "line")).toBe(true)
		expect(preview.files.some((f) => f.rel.endsWith("note.md.hbs") && f.source.includes("{{#slot"))).toBe(true)

		const filled = await spawnCli(
			["fill", "slot-mod/write", "--slot", "line", "--value", "A short note.", "--title", "Probe"],
			project,
			env,
		)
		expect(filled.code, filled.stderr).toBe(0)

		const first = await spawnCli(["run", "slot-mod/write", "--json", "--title", "Probe"], project, env)
		expect(first.code, first.stderr).toBe(0)
		const firstBody = JSON.parse(first.stdout) as { ok: boolean }
		expect(firstBody.ok).toBe(true)
		const notePath = join(project, "note.md")
		expect(readFileSync(notePath, "utf-8")).toContain("A short note.")
		const firstHash = sha256(readFileSync(notePath, "utf-8"))

		const validated = await spawnCli(["validate", "--json"], project, env)
		expect(validated.code, validated.stderr).toBe(0)

		const second = await spawnCli(["run", "slot-mod/write", "--json", "--title", "Probe"], project, env)
		expect(second.code, second.stderr).toBe(0)
		expect(sha256(readFileSync(notePath, "utf-8"))).toBe(firstHash)
	})

	it("writes a param-only module with no LLM and repeats the same bytes", async () => {
		const home = trackDir(mkdtempSync(join(tmpdir(), "baka-cli-hp-home-")))
		mkdirSync(join(home, ".baka"), { recursive: true })
		const project = trackDir(mkdtempSync(join(tmpdir(), "baka-cli-hp-proj-")))
		copyPlatformFixtures(project, ["honest-mod"])
		const env = isolatedEnv(home)

		const first = await spawnCli(["run", "honest-mod/write", "--json"], project, env)
		expect(first.code, first.stderr).toBe(0)
		const marker = join(project, "marker.txt")
		expect(readFileSync(marker, "utf-8")).toBe("honest-mod was here\n")
		const hash = sha256(readFileSync(marker, "utf-8"))

		const second = await spawnCli(["run", "honest-mod/write", "--json"], project, env)
		expect(second.code, second.stderr).toBe(0)
		expect(sha256(readFileSync(marker, "utf-8"))).toBe(hash)
	})
})
