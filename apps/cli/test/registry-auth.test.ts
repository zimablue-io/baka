// ---------------------------------------------------------------------------
// CLI registry auth tests (architecture §8 decisions 4 + 33; validation
// contract VAL-DISC-001 .. VAL-DISC-005, 032, 033, 034, 046).
//
// Every probe spawns the BUILT CLI (`apps/cli/dist/index.js`) as a subprocess
// with an isolated `BAKA_HOME` (architecture decision 33). The seeded
// registry server on http://localhost:4310 is the auth backend (a real
// Better-Auth + PGlite + email/password seed stack, with API keys seeded
// through the real `POST /api/auth/api-key/create` endpoint). The browser
// flow (VAL-DISC-032) is verified manually once; this file pins the
// unattended token mechanism end-to-end.
//
// Coverage map:
//   VAL-DISC-001  login --token <key> stores per-registry credential, masked
//   VAL-DISC-002  invalid token fails truthfully without writing config
//   VAL-DISC-003  whoami with stored creds prints identity + registry URL
//   VAL-DISC-004  whoami without creds exits 1 with an honest error
//   VAL-DISC-005  logout removes cred; whoami then behaves like VAL-DISC-004
//   VAL-DISC-033  the API key never appears in any captured output / log
//   VAL-DISC-034  revoked key produces a "rejected, re-login" message
//   VAL-DISC-046  credentials are scoped per registry across multiple URLs
//   decision 33   BAKA_HOME replaces ~/.baka entirely
//   decision 4    credentials scoped per registry (per-URL config sections)
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

interface OwnerCreds {
	ownerKey: string
	ownerKeyId: string
	ownerEmail: string
	ownerUserId: string
	ownerCookie: string
	baseUrl: string
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

/**
 * Boot a private seed-publishing-server on an ephemeral port for the
 * duration of the suite. Every test uses an isolated BAKA_HOME so they
 * share only this server's state, which is itself fresh per run.
 */
async function bootSeedServer(): Promise<{
	baseUrl: string
	credsFile: string
	pid: number
	stop: () => Promise<void>
}> {
	const dataDir = mkdtempSync(join(tmpdir(), "baka-regauth-"))
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
	// Wait for the listener to come up by polling healthz.
	const baseUrl = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/healthz`)
			if (res.ok) {
				// Wait for the creds file to land too (it's written
				// after the listener binds but on a separate path).
				if (existsSync(credsFile)) break
			}
		} catch {
			// server not ready yet
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
			// Find the actual node server PID (the spawn wrapper is the
			// npx shim; the listener is the inner tsx process). Send
			// SIGTERM to the process group so both go down cleanly.
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
			} else {
				try {
					child.kill("SIGTERM")
				} catch {
					// best effort
				}
			}
			// Give the process a moment to release the port.
			await new Promise((r) => setTimeout(r, 500))
		},
	}
}

interface SpawnResult {
	code: number | null
	stdout: string
	stderr: string
}

function spawnCli(argv: string[], cwd: string, env: Record<string, string>, timeoutMs = 30_000): Promise<SpawnResult> {
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

const createdDirs: string[] = []
function makeIsolatedHome(prefix: string): string {
	const base = mkdtempSync(join(tmpdir(), prefix))
	createdDirs.push(base)
	const bakaHome = join(base, "baka-home")
	mkdirSync(bakaHome, { recursive: true })
	return bakaHome
}

function configPath(bakaHome: string): string {
	return join(bakaHome, "config.json")
}

/**
 * Seeds a credential into `$BAKA_HOME/config.json` directly. Used by
 * tests that need the config to exist BEFORE the CLI runs (the CLI
 * subprocess has its own process.env, so calling the in-process
 * `writeRegistryCredential` helper would write to a different path).
 * Mirrors the storage shape in `apps/cli/src/lib/registry-credentials.ts`.
 */
function seedCredential(bakaHome: string, url: string, apiKey: string): void {
	const path = configPath(bakaHome)
	const text = existsSync(path) ? readFileSync(path, "utf-8").trim() : ""
	let root: Record<string, unknown> = {}
	if (text !== "") {
		try {
			root = JSON.parse(text) as Record<string, unknown>
		} catch {
			root = {}
		}
	}
	const registries =
		root.registries !== undefined &&
		root.registries !== null &&
		typeof root.registries === "object" &&
		!Array.isArray(root.registries)
			? { ...(root.registries as Record<string, unknown>) }
			: {}
	// Mirror the CLI's normalizeRegistryUrl semantics: drop trailing
	// slashes, lowercase scheme/host. The test file uses raw URLs, so
	// for the URL-form normalization test we deliberately pass
	// already-normalized values.
	registries[url] = { apiKey }
	root.registries = registries
	mkdirSync(bakaHome, { recursive: true })
	writeFileSync(path, JSON.stringify(root, null, 2), "utf-8")
}

let server: Awaited<ReturnType<typeof bootSeedServer>> | null = null
let owner: OwnerCreds

beforeAll(async () => {
	if (!existsSync(DIST_INDEX)) {
		throw new Error(`built CLI not found at ${DIST_INDEX}; run \`pnpm --filter baka build\` first`)
	}
	server = await bootSeedServer()
	const raw = JSON.parse(readFileSync(server.credsFile, "utf-8")) as Record<string, Record<string, string>>
	owner = {
		ownerKey: raw.keys.owner,
		ownerKeyId: raw.keyIds.owner,
		ownerEmail: raw.emails.owner,
		ownerUserId: raw.userIds.owner,
		ownerCookie: raw.cookies.owner,
		baseUrl: server.baseUrl,
	}
}, 60_000)

afterAll(async () => {
	for (const d of createdDirs.splice(0)) {
		if (existsSync(d)) rmSync(d, { recursive: true, force: true })
	}
	if (server) {
		await server.stop()
		server = null
	}
}, 30_000)

async function revokeKey(keyId: string): Promise<void> {
	const res = await fetch(`${owner.baseUrl}/api/auth/api-key/delete`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": owner.ownerKey },
		body: JSON.stringify({ keyId }),
	})
	if (!res.ok) {
		throw new Error(`revoke failed: ${res.status} ${await res.text()}`)
	}
}

/**
 * Creates a fresh API key for the seeded owner user via the cookie
 * path (api-key create requires the session cookie + origin check,
 * not just the x-api-key header — see auth-api-keys.test.ts).
 */
async function createFreshKey(label: string): Promise<{ key: string; keyId: string }> {
	const res = await fetch(`${owner.baseUrl}/api/auth/api-key/create`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: owner.baseUrl,
			cookie: owner.ownerCookie,
		},
		body: JSON.stringify({ name: label }),
	})
	if (!res.ok) {
		throw new Error(`api-key create failed: ${res.status} ${await res.text()}`)
	}
	const body = (await res.json()) as { id: string; key: string }
	return { key: body.key, keyId: body.id }
}

// ---------------------------------------------------------------------------
// VAL-DISC-001 — login --token <key> stores per-registry credential
// ---------------------------------------------------------------------------

describe("VAL-DISC-001 login with --token stores the per-registry credential and masks the key", () => {
	it("writes the key into $BAKA_HOME/config.json under the registry URL and prints a masked confirmation", async () => {
		const bakaHome = makeIsolatedHome("baka-regauth-login-")
		const cwd = makeIsolatedHome("baka-regauth-login-proj-")
		const env = { BAKA_HOME: bakaHome }

		const res = await spawnCli(["registry", "login", "--registry", owner.baseUrl, "--token", owner.ownerKey], cwd, env)
		expect(res.code, `login failed: stdout=${res.stdout}; stderr=${res.stderr}`).toBe(0)
		// Masked key prefix is the contract surface — see maskApiKey.
		expect(res.stdout).toMatch(/\(key …[A-Za-z0-9]+\)/)
		// The raw key must never appear in stdout.
		expect(res.stdout).not.toContain(owner.ownerKey)
		// Config file is at $BAKA_HOME/config.json, not $HOME/.baka/config.json.
		const path = configPath(bakaHome)
		expect(existsSync(path)).toBe(true)
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			registries: Record<string, { apiKey: string }>
		}
		expect(parsed.registries[owner.baseUrl]).toEqual({ apiKey: owner.ownerKey })
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-002 — invalid token fails truthfully and writes nothing
// ---------------------------------------------------------------------------

describe("VAL-DISC-002 login with an invalid token fails truthfully and writes nothing", () => {
	it("exits 1 with an honest error naming the rejection, and the config file is unchanged", async () => {
		const bakaHome = makeIsolatedHome("baka-regauth-bad-")
		const cwd = makeIsolatedHome("baka-regauth-bad-proj-")
		const env = { BAKA_HOME: bakaHome }
		// Pre-seed a benign file so we can prove the bad-token flow did
		// NOT touch the file. The CLI MUST NOT overwrite or delete it.
		mkdirSync(bakaHome, { recursive: true })
		const pre = { worker: { baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "k" } }
		writeFileSync(configPath(bakaHome), JSON.stringify(pre, null, 2))
		const preBytes = readFileSync(configPath(bakaHome), "utf-8")

		const res = await spawnCli(
			["registry", "login", "--registry", owner.baseUrl, "--token", "not-a-real-key"],
			cwd,
			env,
		)
		expect(res.code, `expected non-zero exit; stdout=${res.stdout}`).not.toBe(0)
		expect(res.stderr).toMatch(/rejected|HTTP 401/)
		expect(res.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		// The pre-existing config file is unchanged.
		expect(readFileSync(configPath(bakaHome), "utf-8")).toBe(preBytes)
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-003 — whoami with creds prints identity + registry URL
// ---------------------------------------------------------------------------

describe("VAL-DISC-003 whoami with stored credentials prints the identity and registry URL", () => {
	it("exits 0 and reports the user's email/name + the registry URL", async () => {
		const bakaHome = makeIsolatedHome("baka-regauth-whoami-")
		const cwd = makeIsolatedHome("baka-regauth-whoami-proj-")
		const env = { BAKA_HOME: bakaHome }
		// Seed the credential directly so the config file exists in the
		// subprocess's BAKA_HOME. The CLI reads via bakaHomeDir() which
		// picks up BAKA_HOME from the spawn env.
		seedCredential(bakaHome, owner.baseUrl, owner.ownerKey)

		const res = await spawnCli(["registry", "whoami", "--registry", owner.baseUrl], cwd, env)
		expect(res.code, `whoami failed: stdout=${res.stdout}; stderr=${res.stderr}`).toBe(0)
		expect(res.stdout).toContain(`registry: ${owner.baseUrl}`)
		expect(res.stdout).toContain("user:")
		expect(res.stdout).toContain(owner.ownerEmail)
		expect(res.stdout).toContain("key:")
		expect(res.stdout).toMatch(/…[A-Za-z0-9]{4}/)
		// The raw key never appears.
		expect(res.stdout).not.toContain(owner.ownerKey)
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-004 — whoami without creds fails honestly
// ---------------------------------------------------------------------------

describe("VAL-DISC-004 whoami without stored credentials fails honestly", () => {
	it("exits 1 with a message directing the user to `baka registry login`", async () => {
		const bakaHome = makeIsolatedHome("baka-regauth-empty-")
		const cwd = makeIsolatedHome("baka-regauth-empty-proj-")
		const env = { BAKA_HOME: bakaHome }

		const res = await spawnCli(["registry", "whoami", "--registry", owner.baseUrl], cwd, env)
		expect(res.code).toBe(1)
		expect(res.stderr).toContain("no credential stored")
		expect(res.stderr).toContain("baka registry login")
		expect(res.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		expect(res.stderr).not.toContain("undefined")
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-005 — logout removes the credential; whoami then behaves as in 004
// ---------------------------------------------------------------------------

describe("VAL-DISC-005 logout removes the credential and flips whoami to the empty path", () => {
	it("logout exits 0, removes the per-registry section, and a subsequent whoami exits 1", async () => {
		const bakaHome = makeIsolatedHome("baka-regauth-logout-")
		const cwd = makeIsolatedHome("baka-regauth-logout-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, owner.baseUrl, owner.ownerKey)
		const path = configPath(bakaHome)

		const logout = await spawnCli(["registry", "logout", "--registry", owner.baseUrl], cwd, env)
		expect(logout.code, `logout failed: stdout=${logout.stdout}; stderr=${logout.stderr}`).toBe(0)
		expect(logout.stdout).toContain(`removed credential for ${owner.baseUrl}`)

		// The registries map is gone (empty config, role blocks preserved
		// when there were any — none here, so the file is fully empty).
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
		expect(parsed.registries).toBeUndefined()

		const whoami = await spawnCli(["registry", "whoami", "--registry", owner.baseUrl], cwd, env)
		expect(whoami.code).toBe(1)
		expect(whoami.stderr).toContain("no credential stored")
	})
})

// ---------------------------------------------------------------------------
// VAL-DISC-033 — the API key never appears in any output or log
// ---------------------------------------------------------------------------

describe("VAL-DISC-033 the API key never appears in any captured output or log file", () => {
	it("whoami / logout / revoked-key error paths all redact the key", async () => {
		// Use a fresh key for this probe so revoking it doesn't disturb
		// the shared owner key used by sibling tests.
		const fresh = await createFreshKey("regauth-leak-")
		const bakaHome = makeIsolatedHome("baka-regauth-leak-")
		const cwd = makeIsolatedHome("baka-regauth-leak-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, owner.baseUrl, fresh.key)

		const whoami = await spawnCli(["registry", "whoami", "--registry", owner.baseUrl], cwd, env)
		expect(whoami.code).toBe(0)
		expect(whoami.stdout + whoami.stderr).not.toContain(fresh.key)

		// Logout path.
		const logout = await spawnCli(["registry", "logout", "--registry", owner.baseUrl], cwd, env)
		expect(logout.code).toBe(0)
		expect(logout.stdout + logout.stderr).not.toContain(fresh.key)

		// Revoked-key error path: re-seed, revoke, expect 1 + redacted error.
		seedCredential(bakaHome, owner.baseUrl, fresh.key)
		await revokeKey(fresh.keyId)
		const badWhoami = await spawnCli(["registry", "whoami", "--registry", owner.baseUrl], cwd, env)
		expect(badWhoami.code).toBe(1)
		expect(badWhoami.stdout + badWhoami.stderr).not.toContain(fresh.key)
	}, 60_000)
})

// ---------------------------------------------------------------------------
// VAL-DISC-034 — revoked key produces an honest re-login message
// ---------------------------------------------------------------------------

describe("VAL-DISC-034 a revoked key produces an honest re-login message", () => {
	it("after revoke, whoami exits non-zero with a 'rejected, run login again' message; the stale key remains in config.json (the CLI does not silently delete it)", async () => {
		// Fresh key so we don't disturb sibling tests' shared owner key.
		const fresh = await createFreshKey("regauth-revoke-")
		const bakaHome = makeIsolatedHome("baka-regauth-revoke-")
		const cwd = makeIsolatedHome("baka-regauth-revoke-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, owner.baseUrl, fresh.key)

		await revokeKey(fresh.keyId)
		const res = await spawnCli(["registry", "whoami", "--registry", owner.baseUrl], cwd, env)
		expect(res.code).not.toBe(0)
		// Honest error — names the rejection and points to re-login.
		expect(res.stderr).toMatch(/rejected|401/)
		expect(res.stderr).toContain("baka registry login")
		expect(res.stderr).not.toContain("not found")
		expect(res.stderr).not.toContain("fetch failed")
		expect(res.stderr).not.toMatch(/\bat .+\.js:\d+:\d+/)
		// The stale key remains on disk (the CLI does not silently
		// rewrite the config when the server rejects the key). The
		// contract lets the CLI either keep the stale key OR
		// remove it explicitly with a notice — here we pin the
		// "keep" branch because it is the deterministic, audit-
		// friendly choice (VAL-DISC-034 step text).
		const parsed = JSON.parse(readFileSync(configPath(bakaHome), "utf-8")) as Record<string, Record<string, string>>
		expect(parsed.registries?.[owner.baseUrl]).toEqual({ apiKey: fresh.key })
	}, 60_000)
})

// ---------------------------------------------------------------------------
// VAL-DISC-046 — credentials are scoped per registry across multiple URLs
// ---------------------------------------------------------------------------

describe("VAL-DISC-046 credentials are scoped per registry across multiple configured registries", () => {
	it("two registries configured as distinct URL sections; logout on one does not affect the other; whoami routes per URL", async () => {
		// Two distinct URL keys: one is the live registry (whose key
		// actually authenticates); the other is a synthetic URL whose
		// stored key is intentionally invalid — its presence proves the
		// storage layer scopes credentials per registry URL.
		const alpha = owner.baseUrl
		const beta = `http://localhost:1` // unreachable, never used as HTTP target
		const bakaHome = makeIsolatedHome("baka-regauth-multi-")
		const cwd = makeIsolatedHome("baka-regauth-multi-proj-")
		const env = { BAKA_HOME: bakaHome }
		seedCredential(bakaHome, alpha, owner.ownerKey)
		seedCredential(bakaHome, beta, "another-fake-key-just-for-storage-isolation")

		const cfg = JSON.parse(readFileSync(configPath(bakaHome), "utf-8")) as Record<string, Record<string, string>>
		expect(Object.keys(cfg.registries ?? {}).length).toBe(2)
		expect(cfg.registries?.[alpha]).toEqual({ apiKey: owner.ownerKey })
		expect(cfg.registries?.[beta]).toEqual({ apiKey: "another-fake-key-just-for-storage-isolation" })

		// whoami against the alpha URL succeeds.
		const alphaWhoami = await spawnCli(["registry", "whoami", "--registry", alpha], cwd, env)
		expect(alphaWhoami.code, `alpha whoami failed: ${alphaWhoami.stderr}`).toBe(0)
		expect(alphaWhoami.stdout).toContain(`registry: ${alpha}`)
		expect(alphaWhoami.stdout).toContain(owner.ownerEmail)
		expect(alphaWhoami.stdout).not.toContain(owner.ownerKey)

		// URL-form normalization: logging in via the CLI with a
		// trailing-slash registry URL must NOT create a duplicate
		// entry. The CLI normalizes the URL on both read and write;
		// the test exercises the write path by routing through the
		// actual `baka registry login` command.
		const loginTrailing = await spawnCli(
			["registry", "login", "--registry", `${alpha}/`, "--token", owner.ownerKey],
			cwd,
			env,
		)
		expect(loginTrailing.code, `trailing-slash login failed: ${loginTrailing.stderr}`).toBe(0)
		const cfgAfter = JSON.parse(readFileSync(configPath(bakaHome), "utf-8")) as Record<string, Record<string, string>>
		expect(Object.keys(cfgAfter.registries ?? {}).length).toBe(2)

		// Logout alpha (via the normalized form — the CLI strips the
		// trailing slash when looking up the entry) — beta must
		// remain intact.
		const logoutAlpha = await spawnCli(["registry", "logout", "--registry", alpha], cwd, env)
		expect(logoutAlpha.code, `logout alpha failed: ${logoutAlpha.stderr}`).toBe(0)
		const cfgAfterLogout = JSON.parse(readFileSync(configPath(bakaHome), "utf-8")) as Record<
			string,
			Record<string, string>
		>
		expect(cfgAfterLogout.registries?.[alpha]).toBeUndefined()
		expect(cfgAfterLogout.registries?.[beta]).toEqual({ apiKey: "another-fake-key-just-for-storage-isolation" })

		// Logout via the trailing-slash form must reach the same
		// entry (URL normalization on read).
		const logoutAlphaTrailing = await spawnCli(["registry", "logout", "--registry", `${alpha}/`], cwd, env)
		// `baka registry logout` reports "no credential stored" when
		// the entry is already gone — that's the honest message for a
		// second logout attempt (the test pins the no-double-removal
		// branch by also re-asserting the config is unchanged).
		// The CLI normalizes the URL on read, so the message names
		// the normalized form (no trailing slash).
		expect(logoutAlphaTrailing.code).toBe(0)
		expect(logoutAlphaTrailing.stdout).toContain(`no credential stored for ${alpha}`)
		const cfgAfterDoubleLogout = JSON.parse(readFileSync(configPath(bakaHome), "utf-8")) as Record<
			string,
			Record<string, string>
		>
		expect(cfgAfterDoubleLogout.registries?.[alpha]).toBeUndefined()
		expect(cfgAfterDoubleLogout.registries?.[beta]).toEqual({ apiKey: "another-fake-key-just-for-storage-isolation" })

		// After logout, alpha whoami reports "no credential stored".
		const alphaWhoamiAfterLogout = await spawnCli(["registry", "whoami", "--registry", alpha], cwd, env)
		expect(alphaWhoamiAfterLogout.code).toBe(1)
		expect(alphaWhoamiAfterLogout.stderr).toContain("no credential stored")
	}, 60_000)
})
