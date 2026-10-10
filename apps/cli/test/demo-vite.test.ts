// Consumer-project e2e: the demo Vite packs write a real app tree.
// Discovers, inspects templates, fills slots, writes, repeats identically.

import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const DEMO_PACKS = join(BAKA_REPO, "demo", "packs")

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

function copyDemoPacks(projectRoot: string): void {
	mkdirSync(join(projectRoot, "packs"), { recursive: true })
	for (const name of ["vite-app", "vite-theme", "vite-page"] as const) {
		cpSync(join(DEMO_PACKS, name), join(projectRoot, "packs", name), { recursive: true })
	}
}

describe("demo Vite packs write a real app", () => {
	it("lists, inspects, fills, writes package.json + TS, and repeats the same bytes", async () => {
		const home = trackDir(mkdtempSync(join(tmpdir(), "baka-demo-home-")))
		mkdirSync(join(home, ".baka"), { recursive: true })
		const project = trackDir(mkdtempSync(join(tmpdir(), "baka-demo-proj-")))
		copyDemoPacks(project)
		const env = isolatedEnv(home)

		const listed = await spawnCli(["list-packs", "--json"], project, env)
		expect(listed.code, listed.stderr).toBe(0)
		const listPayload = JSON.parse(listed.stdout) as { packs: Array<{ name: string }> }
		expect(listPayload.packs.map((m) => m.name).sort()).toEqual(["vite-app", "vite-page", "vite-theme"])

		const inspected = await spawnCli(["inspect", "vite-app/write", "--json"], project, env)
		expect(inspected.code, inspected.stderr).toBe(0)
		const preview = JSON.parse(inspected.stdout) as {
			files: Array<{ rel: string; source: string }>
			slots: Array<{ id: string }>
			params: Array<{ name: string }>
		}
		expect(preview.params.some((p) => p.name === "name")).toBe(true)
		expect(preview.slots.map((s) => s.id).sort()).toEqual(["blurb", "headline"])
		expect(preview.files.some((f) => f.rel === "src/main.ts.hbs" && f.source.includes("createElement"))).toBe(true)
		expect(preview.files.some((f) => f.rel === "package.json.hbs")).toBe(true)

		const fillHeadline = await spawnCli(
			[
				"fill",
				"vite-app/write",
				"--slot",
				"headline",
				"--value",
				"A local board for shipping notes.",
				"--name",
				"north-room",
			],
			project,
			env,
		)
		expect(fillHeadline.code, fillHeadline.stderr).toBe(0)
		const fillBlurb = await spawnCli(
			[
				"fill",
				"vite-app/write",
				"--slot",
				"blurb",
				"--value",
				"Teams pin what they are building. Nobody waits on a generated layout.",
				"--name",
				"north-room",
			],
			project,
			env,
		)
		expect(fillBlurb.code, fillBlurb.stderr).toBe(0)

		const appRun = await spawnCli(["run", "vite-app/write", "--json", "--name", "north-room"], project, env)
		expect(appRun.code, appRun.stderr).toBe(0)
		const appBody = JSON.parse(appRun.stdout) as { ok: boolean }
		expect(appBody.ok).toBe(true)

		const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf-8")) as {
			name: string
			scripts: Record<string, string>
		}
		expect(pkg.name).toBe("north-room")
		expect(pkg.scripts.dev).toContain("vite")
		const mainTs = readFileSync(join(project, "src/main.ts"), "utf-8")
		expect(mainTs).toContain("createElement")
		expect(mainTs).toContain("A local board for shipping notes.")
		expect(mainTs).not.toContain("{{#slot")
		const firstHash = sha256(mainTs)

		const themeRun = await spawnCli(
			[
				"run",
				"vite-theme/write",
				"--json",
				"--accent",
				"#c45c26",
				"--background",
				"#f4efe6",
				"--ink",
				"#1c1915",
				"--font",
				"Iowan Old Style, Palatino, Georgia, serif",
			],
			project,
			env,
		)
		expect(themeRun.code, themeRun.stderr).toBe(0)
		const css = readFileSync(join(project, "src/styles.css"), "utf-8")
		expect(css).toContain("--accent: #c45c26")
		expect(css).toContain("#app")

		const fillBody = await spawnCli(
			[
				"fill",
				"vite-page/write",
				"--slot",
				"body",
				"--value",
				"North Room started as a desk. It is now the wall we actually look at.",
				"--slug",
				"about",
				"--title",
				"About",
			],
			project,
			env,
		)
		expect(fillBody.code, fillBody.stderr).toBe(0)
		const pageRun = await spawnCli(
			["run", "vite-page/write", "--json", "--slug", "about", "--title", "About"],
			project,
			env,
		)
		expect(pageRun.code, pageRun.stderr).toBe(0)
		expect(readFileSync(join(project, "about.html"), "utf-8")).toContain("/src/about.ts")
		expect(readFileSync(join(project, "src/about.ts"), "utf-8")).toContain("North Room started as a desk.")

		const second = await spawnCli(["run", "vite-app/write", "--json", "--name", "north-room"], project, env)
		expect(second.code, second.stderr).toBe(0)
		expect(sha256(readFileSync(join(project, "src/main.ts"), "utf-8"))).toBe(firstHash)
	})
})
