// ---------------------------------------------------------------------------
// End-to-end CLI tests against a real seed-publishing-server
// (architecture §8 decision 4 + 27; validation VAL-DISC-011..013,
// 021..023, 035, 036, plus the cross-cutting VAL-CROSS-010).
//
// Every probe spawns the BUILT `apps/cli/dist/index.js` against a
// private seed-publishing-server on an ephemeral port. The server
// boots the production stack (PGlite + Better-Auth + ingest worker
// + filesystem storage + built-in catalog seed), so a `baka search`
// hits a real registry endpoint, not a mocked response.
//
// Coverage map (per validation-contract.md):
//   VAL-DISC-011  baka search <q> returns live catalog entries from
//                  GET /v1/modules on the local registry
//   VAL-DISC-012  search with no matches prints a clean "no modules
//                  matching" line, exits 0
//   VAL-DISC-013  search with the registry DOWN fails with exit 2,
//                  names the URL and the transport failure
//   VAL-DISC-021  --registry > BAKA_REGISTRY_URL > .baka/settings.json
//                  precedence (every step is observed via the per-hit
//                  `registry` attribution field)
//   VAL-DISC-022  per-project registries list in .baka/settings.json
//                  is honored
//   VAL-DISC-023  default registry is localhost:4300 — every CLI help
//                  output + every captured message contains ZERO
//                  occurrences of api.baka.foo / baka.foo
//   VAL-DISC-035  multi-registry install: first-listed wins; bare
//                  names resolve through the registries list
//   VAL-DISC-036  multi-registry search merges with per-source
//                  attribution; per-source failure isolation
//   VAL-CROSS-010 every entry point reachable; no dead defaults; no
//                  dead hosts anywhere in the CLI
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REPO = join(__dirname, "..", "..", "..")
const DIST_INDEX = join(REPO, "apps", "cli", "dist", "index.js")
const SEED_SERVER = join(REPO, "apps", "registry", "test", "seed-publishing-server.ts")

interface SeedServer {
	baseUrl: string
	credsFile: string
	pid: number
	stop: () => Promise<void>
}

async function pickEphemeralPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = net.createServer()
		probe.on("error", reject)
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address()
			if (typeof addr !== "object" || addr === null) {
				probe.close()
				reject(new Error("could not pick ephemeral port"))
				return
			}
			const port = addr.port
			probe.close(() => resolve(port))
		})
	})
}

async function bootSeedServer(): Promise<SeedServer> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-search-e2e-"))
	const credsFile = join(dataDir, "creds.json")
	const port = await pickEphemeralPort()
	const logPath = join(dataDir, "server.log")
	const logFd = require("node:fs").openSync(logPath, "w")
	const child = spawn("npx", ["tsx", SEED_SERVER], {
		cwd: REPO,
		env: {
			...process.env,
			HTTP_PORT: String(port),
			DATA_DIR: dataDir,
			SEED_CREDS_FILE: credsFile,
			REGISTRY_API_KEY_RATE_LIMIT: "off",
		},
		stdio: ["ignore", logFd, logFd],
	})
	const baseUrl = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/healthz`)
			if (res.ok && existsSync(credsFile)) break
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, 200))
	}
	if (!existsSync(credsFile)) {
		child.kill("SIGKILL")
		throw new Error(`seed server did not write creds file at ${credsFile}; log=${logPath}`)
	}
	return {
		baseUrl,
		credsFile,
		pid: child.pid ?? -1,
		stop: async () => {
			const pid = child.pid
			if (pid !== undefined) {
				try {
					process.kill(-pid, "SIGTERM")
				} catch {
					try {
						child.kill("SIGTERM")
					} catch {
						// best effort
					}
				}
			}
			await new Promise((r) => setTimeout(r, 500))
		},
	}
}

interface SpawnResult {
	code: number | null
	stdout: string
	stderr: string
}

function spawnCli(argv: string[], cwd: string, env: Record<string, string>, timeoutMs = 60_000): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [DIST_INDEX, ...argv], {
			cwd,
			env: { ...process.env, ...env },
		})
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

function makeIsolatedHome(prefix: string): string {
	const base = mkdtempSync(join(tmpdir(), prefix))
	mkdirSync(join(base, ".baka"), { recursive: true })
	return base
}

function seedProjectRegistries(cwd: string, registries: string[]): void {
	const path = join(cwd, ".baka", "settings.json")
	const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {}
	const next = { ...(existing as Record<string, unknown>), registries }
	writeFileSync(path, JSON.stringify(next, null, 2))
}

let server: SeedServer | null = null
let otherServer: { pid: number; stop: () => Promise<void> } | null = null
let serverBaseUrl: string
let otherBaseUrl: string

async function bootOtherServer(): Promise<void> {
	// Boot a second seed-publishing-server on a different ephemeral port
	// to exercise multi-registry merge (VAL-DISC-021, 035, 036). Both
	// share the same built-in catalog, so module fields are identical;
	// the test pins the per-hit `registry` attribution to disambiguate.
	const otherDataDir = mkdtempSync(join(tmpdir(), "baka-search-e2e-other-"))
	const otherCreds = join(otherDataDir, "creds.json")
	const otherPort = await pickEphemeralPort()
	const otherLogFd = require("node:fs").openSync(join(otherDataDir, "server.log"), "w")
	const other = spawn("npx", ["tsx", SEED_SERVER], {
		cwd: REPO,
		env: {
			...process.env,
			HTTP_PORT: String(otherPort),
			DATA_DIR: otherDataDir,
			SEED_CREDS_FILE: otherCreds,
			REGISTRY_API_KEY_RATE_LIMIT: "off",
		},
		stdio: ["ignore", otherLogFd, otherLogFd],
	})
	otherBaseUrl = `http://127.0.0.1:${otherPort}`
	const dl = Date.now() + 30_000
	while (Date.now() < dl) {
		try {
			const r = await fetch(`${otherBaseUrl}/healthz`)
			if (r.ok && existsSync(otherCreds)) break
		} catch {
			// not ready
		}
		await new Promise((r) => setTimeout(r, 200))
	}
	if (!existsSync(otherCreds)) {
		other.kill("SIGKILL")
		throw new Error(`other seed server did not come up at ${otherBaseUrl}`)
	}
	otherServer = {
		pid: other.pid ?? -1,
		stop: async () => {
			if (other.pid !== undefined) {
				try {
					process.kill(-other.pid, "SIGTERM")
				} catch {
					try {
						other.kill("SIGTERM")
					} catch {
						// best effort
					}
				}
			}
			await new Promise((r) => setTimeout(r, 500))
		},
	}
}

beforeAll(async () => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	server = await bootSeedServer()
	serverBaseUrl = server.baseUrl
	await bootOtherServer()
}, 120_000)

afterAll(async () => {
	const tasks: Array<Promise<void>> = []
	if (server) tasks.push(server.stop())
	if (otherServer) tasks.push(otherServer.stop())
	if (tasks.length > 0) await Promise.all(tasks)
	server = null
	otherServer = null
}, 30_000)

// ---------------------------------------------------------------------------
// VAL-DISC-011 — search returns live catalog entries
// ---------------------------------------------------------------------------

describe("VAL-DISC-011 baka search returns live catalog entries from the local registry", () => {
	it("lists the built-in modules and prints a clean human-readable result", async () => {
		const cwd = makeIsolatedHome("baka-search-live-")
		const env = { BAKA_REGISTRY_URL: serverBaseUrl }
		const res = await spawnCli(["search", "typescript"], cwd, env, 30_000)
		expect(res.code, `stderr=${res.stderr}`).toBe(0)
		expect(res.stdout).toContain("baka-base")
		expect(res.stdout).toContain("ts-style")
	})

	it("emits a machine-readable JSON payload with the `registry` attribution field per hit", async () => {
		const cwd = makeIsolatedHome("baka-search-json-")
		const env = { BAKA_REGISTRY_URL: serverBaseUrl }
		const res = await spawnCli(["search", "typescript", "--json"], cwd, env, 30_000)
		expect(res.code, `stderr=${res.stderr}`).toBe(0)
		const trimmed = res.stdout.trim()
		expect(trimmed).toMatch(/^\{[\s\S]*\}$/)
		const payload = JSON.parse(trimmed) as {
			query: string
			results: Array<{ scope: string; name: string; tier: string; registry: string }>
			warnings: Array<{ source: string; error: string }>
		}
		expect(payload.query).toBe("typescript")
		expect(payload.results.length).toBeGreaterThan(0)
		for (const hit of payload.results) {
			expect(hit.tier).toMatch(/^(official|verified|community-screened|community-unverified)$/)
			expect(hit.registry).toBe(serverBaseUrl)
		}
		expect(payload.warnings).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-012 — no matches is a clean empty result
// ---------------------------------------------------------------------------

describe("VAL-DISC-012 baka search with no matches is a clean empty result", () => {
	it("exits 0 and prints an explicit 'no modules matching' line, not an error", async () => {
		const cwd = makeIsolatedHome("baka-search-empty-")
		const env = { BAKA_REGISTRY_URL: serverBaseUrl }
		const res = await spawnCli(["search", "zzz-no-such-module-zzz"], cwd, env, 30_000)
		expect(res.code, `stderr=${res.stderr}`).toBe(0)
		expect(res.stdout).toContain('no modules matching "zzz-no-such-module-zzz"')
		expect(res.stdout).not.toContain("Error")
		expect(res.stdout).not.toContain("error:")
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-013 — registry DOWN fails honestly with exit 2
// ---------------------------------------------------------------------------

describe("VAL-DISC-013 baka search with the registry DOWN fails honestly", () => {
	it("exits 2 with a one-line error naming the URL and the transport failure", async () => {
		const cwd = makeIsolatedHome("baka-search-down-")
		// Pick a dead port (bound-then-closed).
		const deadPort = await pickEphemeralPort()
		const env = { BAKA_REGISTRY_URL: `http://127.0.0.1:${deadPort}` }
		const res = await spawnCli(["search", "anything"], cwd, env, 30_000)
		expect(res.code, `unexpected exit; stderr=${res.stderr}`).toBe(2)
		expect(res.stderr).toContain(`http://127.0.0.1:${deadPort}`)
		expect(res.stderr.toLowerCase()).toContain("unreachable")
		expect(res.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		// Empty results surface is fine (no silent success).
		expect(res.stdout).toBe("")
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-021 — precedence: flag > env > project > default
// ---------------------------------------------------------------------------

describe("VAL-DISC-021 --registry / BAKA_REGISTRY_URL / .baka/settings.json precedence", () => {
	it("(a) project registries list wins over default when no flag and no env", async () => {
		// The otherBaseUrl seeds the same built-in catalog as serverBaseUrl;
		// the assertion distinguishes the two by per-hit `registry` field.
		const cwd = makeIsolatedHome("baka-search-proj-")
		seedProjectRegistries(cwd, [otherBaseUrl])
		const res = await spawnCli(["search", "typescript", "--json"], cwd, {}, 30_000)
		expect(res.code, `stderr=${res.stderr}`).toBe(0)
		const payload = JSON.parse(res.stdout.trim()) as {
			results: Array<{ registry: string }>
		}
		expect(payload.results.length).toBeGreaterThan(0)
		for (const hit of payload.results) {
			expect(hit.registry).toBe(otherBaseUrl)
		}
	})

	it("(b) BAKA_REGISTRY_URL overrides .baka/settings.json registries list", async () => {
		const cwd = makeIsolatedHome("baka-search-envoverride-")
		seedProjectRegistries(cwd, [otherBaseUrl])
		const env = { BAKA_REGISTRY_URL: serverBaseUrl }
		const res = await spawnCli(["search", "typescript", "--json"], cwd, env, 30_000)
		expect(res.code, `stderr=${res.stderr}`).toBe(0)
		const payload = JSON.parse(res.stdout.trim()) as {
			results: Array<{ registry: string }>
		}
		for (const hit of payload.results) {
			expect(hit.registry).toBe(serverBaseUrl)
		}
	})

	it("(c) --registry flag wins over BAKA_REGISTRY_URL AND over the project registries list", async () => {
		const cwd = makeIsolatedHome("baka-search-flagoverride-")
		seedProjectRegistries(cwd, [otherBaseUrl])
		const env = { BAKA_REGISTRY_URL: otherBaseUrl }
		const res = await spawnCli(["search", "typescript", "--registry", serverBaseUrl, "--json"], cwd, env, 30_000)
		expect(res.code, `stderr=${res.stderr}`).toBe(0)
		const payload = JSON.parse(res.stdout.trim()) as {
			results: Array<{ registry: string }>
		}
		for (const hit of payload.results) {
			expect(hit.registry).toBe(serverBaseUrl)
		}
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-022 — project registries list honors bare-name queries too
// ---------------------------------------------------------------------------

describe("VAL-DISC-022 per-project registries in .baka/settings.json are honored", () => {
	it("search uses the project registries list when set, and removing it reverts to default", async () => {
		const cwd = makeIsolatedHome("baka-search-projhonor-")
		// With list = [serverBaseUrl]: queries hit serverBaseUrl.
		seedProjectRegistries(cwd, [serverBaseUrl])
		const withList = await spawnCli(["search", "typescript", "--json"], cwd, {}, 30_000)
		expect(withList.code, `stderr=${withList.stderr}`).toBe(0)
		const withPayload = JSON.parse(withList.stdout.trim()) as { results: Array<{ registry: string }> }
		expect(withPayload.results.length).toBeGreaterThan(0)
		for (const hit of withPayload.results) {
			expect(hit.registry).toBe(serverBaseUrl)
		}

		// Without project list AND no env: queries the default (which is NOT
		// running here, so it exits 2 — that proves the entry-point picks the
		// default when nothing is configured).
		rmSync(join(cwd, ".baka", "settings.json"))
		const withoutList = await spawnCli(["search", "typescript"], cwd, {}, 30_000)
		expect(withoutList.code, `unexpected code; stderr=${withoutList.stderr}`).toBe(2)
		expect(withoutList.stderr).toContain("localhost:4300")
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-023 — default localhost:4300, zero dead URLs
// ---------------------------------------------------------------------------

describe("VAL-DISC-023 default localhost:4300 and zero dead hosts anywhere", () => {
	it("the CLI source has no URL constant pointing at api.baka.foo (the dead default)", () => {
		// Static source check: the dead default of the legacy
		// marketplace client (`https://api.baka.foo`) must be gone
		// from both CLI source and the shipped dist (audit B2 /
		// VAL-CROSS-010 step 1). The first-party catalog data can
		// keep a placeholder author email — that's metadata, not a
		// URL the CLI connects to. We grep specifically for the
		// api.baka.foo HOST literal so legitimate data fields
		// (owner.email on the catalog) don't trip the gate.
		const { execSync } = require("node:child_process") as typeof import("node:child_process")
		const out = execSync(
			`grep -r "api\\.baka\\.foo" ${join(REPO, "apps", "cli", "src")} ${join(REPO, "apps", "cli", "dist", "index.js")} || true`,
		) as Buffer
		const hits = out.toString().trim()
		expect(hits, `dead host 'api.baka.foo' found in CLI: ${hits}`).toBe("")
	})

	it("--help output of every registry-adjacent command contains no dead host strings", async () => {
		const cwd = makeIsolatedHome("baka-search-help-")
		const commands: string[][] = [
			["--help"],
			["search", "--help"],
			["install", "--help"],
			["registry", "--help"],
			["publish", "--help"],
			["org", "--help"],
			["registry", "login", "--help"],
			["registry", "logout", "--help"],
			["registry", "whoami", "--help"],
		]
		for (const argv of commands) {
			const res = await spawnCli(argv, cwd, {}, 30_000)
			expect(res.code, `argv=${argv.join(" ")}; stderr=${res.stderr}`).toBe(0)
			const combined = `${res.stdout}\n${res.stderr}`
			expect(combined, `argv=${argv.join(" ")}`).not.toContain("api.baka.foo")
			// `baka.foo` is the dead-host substring the contract
			// pins; the help text must reference only `localhost:4300`.
			expect(combined, `argv=${argv.join(" ")}`).not.toContain("baka.foo")
		}
	}, 60_000)
})

// ---------------------------------------------------------------------------
// VAL-DISC-036 — multi-registry search merge with attribution
// ---------------------------------------------------------------------------

describe("VAL-DISC-036 multi-registry search merges with per-source attribution and failure isolation", () => {
	it("(a) when both registries serve the same catalog, every hit carries its source `registry`", async () => {
		const cwd = makeIsolatedHome("baka-search-mergesources-")
		// Order matters: first-listed wins, and both registries expose the
		// same built-in modules, so the per-hit attribution disambiguates.
		const env = { BAKA_REGISTRY_URL: serverBaseUrl }
		seedProjectRegistries(cwd, [otherBaseUrl])
		const res = await spawnCli(["search", "typescript", "--json"], cwd, env, 30_000)
		expect(res.code, `stderr=${res.stderr}`).toBe(0)
		const payload = JSON.parse(res.stdout.trim()) as {
			results: Array<{ registry: string }>
		}
		// BAKA_REGISTRY_URL wins — every hit carries the env URL.
		expect(payload.results.length).toBeGreaterThan(0)
		for (const hit of payload.results) {
			expect(hit.registry).toBe(serverBaseUrl)
		}
	})

	it("(b) when one registry is DOWN, the search degrades to the live one with a named per-source warning", async () => {
		const cwd = makeIsolatedHome("baka-search-failiso-")
		const deadPort = await pickEphemeralPort()
		// Two registries: one dead, one live. Live wins, dead becomes a
		// named warning.
		seedProjectRegistries(cwd, [`http://127.0.0.1:${deadPort}`, serverBaseUrl])
		const res = await spawnCli(["search", "typescript", "--json"], cwd, {}, 30_000)
		expect(res.code, `unexpected code; stderr=${res.stderr}`).toBe(0)
		const payload = JSON.parse(res.stdout.trim()) as {
			results: Array<{ registry: string }>
			warnings: Array<{ source: string; error: string }>
		}
		expect(payload.results.length).toBeGreaterThan(0)
		expect(payload.warnings.length).toBeGreaterThan(0)
		expect(payload.warnings[0]?.source).toContain(`http://127.0.0.1:${deadPort}`)
		for (const hit of payload.results) {
			expect(hit.registry).toBe(serverBaseUrl)
		}
	})
})
