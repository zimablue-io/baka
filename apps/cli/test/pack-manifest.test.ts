// A repository of packs becomes shareable with a moralo.module.json that Baka writes and checks.

import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const BAKA_REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(BAKA_REPO, "apps", "cli", "dist", "index.js")
const FIXTURES = join(__dirname, "fixtures")

const createdDirs: string[] = []
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	createdDirs.push(dir)
	return dir
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\``)
})

function baka(argv: string[], cwd: string) {
	const home = tempDir("baka-manifest-home-")
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn("node", [DIST_INDEX, ...argv], {
			cwd,
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home },
		})
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (b: Buffer) => {
			stdout += b.toString()
		})
		child.stderr.on("data", (b: Buffer) => {
			stderr += b.toString()
		})
		child.on("close", (code) => resolve({ code, stdout, stderr }))
	})
}

/** A repository of two packs, as an author would publish it. */
function packRepo(): string {
	const repo = tempDir("baka-pack-repo-")
	for (const name of ["honest-mod", "slot-mod"]) cpSync(join(FIXTURES, name), join(repo, name), { recursive: true })
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ name: "@acme/baka-packs", version: "2.3.0", description: "Acme's packs", license: "Apache-2.0" }),
	)
	return repo
}

describe("baka pack manifest", () => {
	it("describes a repository of packs: one runnable node per recipe, kind pack", async () => {
		const repo = packRepo()
		const out = await baka(["pack", "manifest", repo], repo)
		expect(out.code, out.stderr).toBe(0)
		const doc = JSON.parse(out.stdout) as Record<string, unknown> & {
			surfaces: Array<{ id: string; run: string[]; result: string }>
		}
		expect(doc).toMatchObject({
			manifest: 0,
			id: "acme/baka-packs",
			name: "@acme/baka-packs",
			version: "2.3.0",
			license: "Apache-2.0",
			kinds: ["pack"],
			requires: { moralo: ">=0 <1", baka: ">=1 <2" },
		})
		expect(doc.surfaces.map((s) => s.id)).toEqual(["honest-mod.write", "slot-mod.write"])
		expect(doc.surfaces[1]?.run).toEqual(["--packs-dir", "{moduleDir}", "run", "slot-mod/write", "--json"])
		expect(doc.surfaces[1]?.result).toBe("baka.receipt/1")
		expect(existsSync(join(repo, "moralo.module.json"))).toBe(false)
	})

	it("describes a single pack by its own name and version", async () => {
		const repo = tempDir("baka-single-pack-")
		cpSync(join(FIXTURES, "slot-mod"), repo, { recursive: true })
		const out = await baka(["pack", "manifest", "--id", "acme/slot-mod"], repo)
		expect(out.code, out.stderr).toBe(0)
		const doc = JSON.parse(out.stdout) as { id: string; version: string; summary: string; surfaces: unknown[] }
		expect(doc.id).toBe("acme/slot-mod")
		expect(doc.version).toBe("0.0.0")
		expect(doc.surfaces).toHaveLength(1)
	})

	it("--write saves the file and --check agrees with it", async () => {
		const repo = packRepo()
		const write = await baka(["pack", "manifest", "--write"], repo)
		expect(write.code, write.stderr).toBe(0)
		expect(JSON.parse(readFileSync(join(repo, "moralo.module.json"), "utf-8")).id).toBe("acme/baka-packs")
		const check = await baka(["pack", "manifest", "--check"], repo)
		expect(check.code, check.stderr).toBe(0)
	})

	it("--check fails, naming the fix, when the packs changed", async () => {
		const repo = packRepo()
		await baka(["pack", "manifest", "--write"], repo)
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ name: "@acme/baka-packs", version: "2.4.0", license: "Apache-2.0" }),
		)
		const check = await baka(["pack", "manifest", "--check", "--json"], repo)
		expect(check.code).toBe(1)
		const body = JSON.parse(check.stdout) as { error: { code: string; hint: string } }
		expect(body.error.code).toBe("manifest-stale")
		expect(body.error.hint).toContain("--write")
	})

	it("--check fails when there is no file yet", async () => {
		const repo = packRepo()
		const check = await baka(["pack", "manifest", "--check", "--json"], repo)
		expect(check.code).toBe(1)
		expect((JSON.parse(check.stdout) as { error: { code: string } }).error.code).toBe("manifest-missing")
	})

	it("keeps what the author wrote (summary, license, docs) when it regenerates", async () => {
		const repo = packRepo()
		await baka(["pack", "manifest", "--write"], repo)
		const file = join(repo, "moralo.module.json")
		const doc = JSON.parse(readFileSync(file, "utf-8"))
		doc.summary = "Written by hand."
		doc.docs = "https://acme.example/packs"
		writeFileSync(file, JSON.stringify(doc))
		const again = await baka(["pack", "manifest"], repo)
		const regenerated = JSON.parse(again.stdout) as { summary: string; docs: string }
		expect(regenerated.summary).toBe("Written by hand.")
		expect(regenerated.docs).toBe("https://acme.example/packs")
	})

	it("is bad input, exit 2, when it cannot tell the module id", async () => {
		const repo = tempDir("baka-no-id-")
		cpSync(join(FIXTURES, "slot-mod"), join(repo, "slot-mod"), { recursive: true })
		mkdirSync(join(repo, "node_modules"))
		const out = await baka(["pack", "manifest", "--json"], repo)
		expect(out.code).toBe(2)
		expect((JSON.parse(out.stdout) as { error: { hint: string } }).error.hint).toContain("--id")
	})

	it("is bad input, exit 2, where there is no pack", async () => {
		const out = await baka(["pack", "manifest", "--json"], tempDir("baka-no-pack-"))
		expect(out.code).toBe(2)
		expect((JSON.parse(out.stdout) as { error: { code: string } }).error.code).toBe("pack-not-found")
	})
})
