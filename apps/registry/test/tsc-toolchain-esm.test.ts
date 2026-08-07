import { type ChildProcessByStdio, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "./git-fixture"

/**
 * Regression pin for VAL-SCAN-017.
 *
 * The original bug: `runTscNoEmit` in
 * `apps/registry/src/screening/output-validation.ts` resolved the
 * typescript entry via a bare `require.resolve("typescript/bin/tsc")`.
 * The package is `"type": "module"` and the registry dev server runs
 * under `tsx` ESM, where `require` is undefined — so any
 * `toolchain: 'tsc'` action crashed layer 3 with `require is not
 * defined` and the version terminated `failed` with the entire
 * `screening` key null. The vitest suite passed because vitest
 * injects a require shim into ESM modules, masking the production
 * crash. User-testing round 1 surfaced it (evidence under
 * `evidence/screening-previews/group-c/VAL-SCAN-017-tscfail-version-detail.json`).
 *
 * The fix replaces the bare call with
 * `createRequire(import.meta.url).resolve(...)` (the same pattern
 * `dry-run.ts` uses for jiti resolution), which works under any
 * runtime that supports `node:module` — including plain tsx.
 *
 * This test pins the regression by booting the full registry stack
 * (`seed-publishing-server.ts`) as a CHILD PROCESS under plain tsx,
 * then publishing a `toolchain: 'tsc'` module through the live
 * HTTP API and asserting the screening verdict reaches
 * `screened`. Vitest's require shim is irrelevant here: the
 * subprocess has no vitest in its ancestry and loads
 * `output-validation.ts` under stock tsx ESM, exactly like the
 * production dev/start path.
 */

interface SeedCreds {
	httpPort: number
	baseUrl: string
	dataDir: string
	keys: { owner: string }
}

interface SpawnedServer {
	pid: number
	baseUrl: string
	dataDir: string
	creds: SeedCreds
	stop: () => Promise<void>
}

async function pickFreePortInRange(min: number, max: number): Promise<number> {
	for (let port = min; port <= max; port++) {
		const ok = await new Promise<boolean>((resolve) => {
			const probe = net.createServer()
			probe.on("error", () => resolve(false))
			probe.listen(port, "127.0.0.1", () => {
				probe.close(() => resolve(true))
			})
		})
		if (ok) return port
	}
	throw new Error(`no free port in ${min}-${max}`)
}

/**
 * Boots `seed-publishing-server.ts` as a child process under plain
 * tsx (NOT under vitest, so no require shim is injected). Returns
 * the spawned pid + the resolved base URL + the seeded credentials.
 *
 * The process must be killed by PID on teardown — never by port
 * (per AGENTS.md: kill-by-port is only allowed for ports the worker
 * bound itself).
 */
async function bootSeedServer(opts: {
	httpPort: number
	dataDir: string
	credsFile: string
	registryDir: string
}): Promise<SpawnedServer> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HTTP_PORT: String(opts.httpPort),
		DATA_DIR: opts.dataDir,
		SEED_CREDS_FILE: opts.credsFile,
		// Disable rate limiting — the seeded key can be hammered
		// without tripping the per-key limit.
		REGISTRY_API_KEY_RATE_LIMIT: "off",
		// Disable the canary plumbing (architecture §8 decision 39
		// reserves this env var for tests).
		BAKA_DRYRUN_TEST_CANARY_CONFIG: "",
	}
	const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
		"pnpm",
		["--filter", "@baka/registry", "exec", "tsx", "test/seed-publishing-server.ts"],
		{
			cwd: opts.registryDir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	)

	const stdoutChunks: string[] = []
	const stderrChunks: string[] = []
	child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")))
	child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")))

	// Wait for the readiness line the harness prints once serve()
	// has bound. Up to 30s for boot — the harness initializes
	// PGlite, runs migrations, seeds Better-Auth + the org + keys.
	const ready = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
		const onExit = (code: number | null): void => {
			resolve({
				ok: false,
				error: `seed-publishing-server exited before ready (code=${code}); stdout=${stdoutChunks.join("")}; stderr=${stderrChunks.join("")}`,
			})
		}
		child.once("exit", onExit)
		const timer = setInterval(() => {
			const text = stdoutChunks.join("")
			if (text.includes("seed-publishing-server: listening on http://127.0.0.1:")) {
				clearInterval(timer)
				child.off("exit", onExit)
				resolve({ ok: true })
			}
		}, 100)
		setTimeout(() => {
			clearInterval(timer)
			child.off("exit", onExit)
			resolve({
				ok: false,
				error: `seed-publishing-server did not become ready within 30s; stdout=${stdoutChunks.join("")}; stderr=${stderrChunks.join("")}`,
			})
		}, 30_000)
	})
	if (!ready.ok) {
		child.kill("SIGKILL")
		throw new Error(ready.error)
	}

	const credsRaw = readFileSync(opts.credsFile, "utf8")
	const creds = JSON.parse(credsRaw) as SeedCreds

	return {
		pid: child.pid ?? -1,
		baseUrl: creds.baseUrl,
		dataDir: opts.dataDir,
		creds,
		stop: async () => {
			if (child.pid !== undefined && child.pid > 0) {
				try {
					process.kill(child.pid, "SIGTERM")
				} catch {
					// already dead
				}
				await new Promise<void>((resolve) => {
					const t = setTimeout(() => {
						try {
							process.kill(child.pid ?? -1, "SIGKILL")
						} catch {
							// already dead
						}
						resolve()
					}, 5_000)
					child.once("exit", () => {
						clearTimeout(t)
						resolve()
					})
				})
			}
		},
	}
}

interface VersionDetail {
	status?: "pending" | "ingesting" | "ready" | "failed"
	error?: string | null
	screening?: {
		verdict?: string
		outputValidation?: {
			ok?: boolean
			step?: string
			toolchains?: Array<{ actionId: string; toolchain: string; exitCode: number }>
		} | null
	} | null
}

interface PublishedVersionResponse {
	versionId?: string
}

async function fetchVersionDetail(
	baseUrl: string,
	ownerKey: string,
	scope: string,
	name: string,
	version: string,
): Promise<VersionDetail> {
	const res = await fetch(`${baseUrl}/v1/modules/${scope}/${name}/${version}`, {
		headers: { "x-api-key": ownerKey },
	})
	if (!res.ok) {
		throw new Error(`version detail ${scope}/${name}/${version}: ${res.status} ${await res.text()}`)
	}
	return (await res.json()) as VersionDetail
}

async function waitForTerminal(
	baseUrl: string,
	ownerKey: string,
	scope: string,
	name: string,
	version: string,
	timeoutMs: number,
): Promise<VersionDetail> {
	const deadline = Date.now() + timeoutMs
	let last: VersionDetail | null = null
	while (Date.now() < deadline) {
		last = await fetchVersionDetail(baseUrl, ownerKey, scope, name, version)
		if (last.status === "ready" || last.status === "failed") return last
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error(
		`version ${scope}/${name}/${version} did not reach terminal in ${timeoutMs}ms; last=${JSON.stringify(last)}`,
	)
}

// Action body — uses writeFileSync with JSON-stringified config so
// the actual writeFileSync call gets a string. Mirrors the existing
// `output-validation.test.ts` tsc fixtures so the loader resolves
// the same export shape (`default` = WorkflowStep with execute +
// compensate functions). The action writes `src/index.ts` and
// `tsconfig.json` to the sandbox; layer 3 then runs tsc --noEmit
// against them.
const TSC_CLEAN_BODY = `import { writeFileSync, mkdirSync } from "node:fs"
const clean = "export const x: number = 42;\\nexport function main(): void { console.log(x); }\\nmain();\\n"
const tscfg = "{\\"compilerOptions\\":{\\"strict\\":true,\\"target\\":\\"ES2022\\",\\"module\\":\\"ESNext\\",\\"noEmit\\":true,\\"skipLibCheck\\":true},\\"include\\":[\\"src\\"]}"
export default {
  name: "gen-ts",
  role: 1,
  async execute() {
    mkdirSync("src", { recursive: true })
    writeFileSync("src/index.ts", clean)
    writeFileSync("tsconfig.json", tscfg)
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

// Broken-TS body: tsc strict mode flags the assignment of a string
// literal to a number-typed const. Layer 3 must surface this
// diagnostic verbatim on `outputValidation.failure.stderr`.
const TSC_BROKEN_BODY = `import { writeFileSync, mkdirSync } from "node:fs"
const broken = "export const x: number = 'string-not-number';\\n"
const tscfg = "{\\"compilerOptions\\":{\\"strict\\":true,\\"target\\":\\"ES2022\\",\\"module\\":\\"ESNext\\",\\"noEmit\\":true,\\"skipLibCheck\\":true},\\"include\\":[\\"src\\"]}"
export default {
  name: "gen-ts",
  role: 1,
  async execute() {
    mkdirSync("src", { recursive: true })
    writeFileSync("src/index.ts", broken)
    writeFileSync("tsconfig.json", tscfg)
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {},
}
`

describe("tsc toolchain ESM regression (VAL-SCAN-017)", () => {
	let server: SpawnedServer
	let fixture: GitFixture

	beforeAll(async () => {
		const registryDir = join(import.meta.dirname, "..")
		const dataDir = mkdtempSync(join(tmpdir(), "baka-tsc-subproc-"))
		const credsFile = join(dataDir, "creds.json")
		const httpPort = await pickFreePortInRange(4310, 4319)
		// The harness writes to SEED_CREDS_FILE but does not mkdir
		// its parent — pre-create the file path so the harness
		// can write into it.
		mkdirSync(dataDir, { recursive: true })
		server = await bootSeedServer({ httpPort, dataDir, credsFile, registryDir })
		fixture = await createGitFixture()
	}, 90_000)

	afterAll(async () => {
		if (server) await server.stop()
		if (fixture) await fixture.cleanup()
		if (server?.dataDir) rmSync(server.dataDir, { recursive: true, force: true })
	})

	it("a toolchain:'tsc' action screens to `screened` under plain tsx (no vitest require shim)", async () => {
		await fixture.commitManifest({
			name: "@acme/widget-tsc-subprocess",
			version: "1.0.0",
			tag: "v1.0.0",
			modulePath: "m",
			actions: [
				{
					id: "gen-ts",
					description: "writes a clean index.ts",
					filePatterns: ["src/index.ts", "tsconfig.json"],
					toolchain: "tsc",
					body: TSC_CLEAN_BODY,
				},
			],
		})

		const publishRes = await fetch(`${server.baseUrl}/v1/publish`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: server.baseUrl,
				"x-api-key": server.creds.keys.owner,
			},
			body: JSON.stringify({
				repo: fixture.bareUrl,
				tag: "v1.0.0",
				org: "acme",
				visibility: "public",
				modulePath: "m",
			}),
		})
		expect(publishRes.status).toBeGreaterThanOrEqual(200)
		expect(publishRes.status).toBeLessThan(300)
		const { versionId } = (await publishRes.json()) as PublishedVersionResponse
		expect(typeof versionId).toBe("string")

		const terminal = await waitForTerminal(
			server.baseUrl,
			server.creds.keys.owner,
			"acme",
			"widget-tsc-subprocess",
			"v1.0.0",
			90_000,
		)

		// The contract: screening is allowed to fail the version, but
		// the bug under test made it fail with `require is not defined`
		// and a null `screening` key. With the fix in place the
		// control fixture screens cleanly.
		expect(terminal.status).toBe("ready")
		expect(terminal.error ?? null).toBeNull()
		expect(terminal.screening).not.toBeNull()
		expect(terminal.screening?.verdict).toBe("screened")
		expect(terminal.screening?.outputValidation?.ok).toBe(true)
		const toolchains = terminal.screening?.outputValidation?.toolchains ?? []
		expect(toolchains.length).toBeGreaterThan(0)
		expect(toolchains[0]?.toolchain).toBe("tsc")
		expect(toolchains[0]?.exitCode).toBe(0)
		expect(toolchains[0]?.actionId).toBe("gen-ts")

		// Defensive: the bug's signature was `require is not defined`
		// on the version-level error AND a null screening key. Assert
		// the verdict payload itself does not contain that signature
		// — catches any future regression where the bug re-emerges
		// in a different shape (e.g. try/catch swallowing the error
		// but leaving the verdict in an inconsistent state).
		const serialized = JSON.stringify(terminal)
		expect(serialized).not.toMatch(/require is not defined/i)
	}, 120_000)

	it("a toolchain:'tsc' action whose output fails tsc terminates failed with outputValidation naming the toolchain step", async () => {
		// Companion to the control test above: layer 3 must surface
		// the tsc failure honestly (verdict `failed`,
		// outputValidation.step=`toolchain`, exitCode non-zero,
		// stderr quotes the diagnostic). Pre-fix, the whole
		// `screening` key was null because the layer crashed
		// before producing any record.
		await fixture.commitManifest({
			name: "@acme/widget-tscfail-subprocess",
			version: "1.1.0",
			tag: "v1.1.0",
			modulePath: "m",
			actions: [
				{
					id: "gen-ts",
					description: "writes a broken index.ts",
					filePatterns: ["src/index.ts", "tsconfig.json"],
					toolchain: "tsc",
					body: TSC_BROKEN_BODY,
				},
			],
		})

		const publishRes = await fetch(`${server.baseUrl}/v1/publish`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: server.baseUrl,
				"x-api-key": server.creds.keys.owner,
			},
			body: JSON.stringify({
				repo: fixture.bareUrl,
				tag: "v1.1.0",
				org: "acme",
				visibility: "public",
				modulePath: "m",
			}),
		})
		expect(publishRes.status).toBeGreaterThanOrEqual(200)
		expect(publishRes.status).toBeLessThan(300)

		const terminal = await waitForTerminal(
			server.baseUrl,
			server.creds.keys.owner,
			"acme",
			"widget-tscfail-subprocess",
			"v1.1.0",
			90_000,
		)

		// The version terminated failed (a public-version tsc
		// failure flips the verdict) AND the screening record
		// names the toolchain step with a non-zero exit code —
		// not a generic `require is not defined` crash.
		expect(terminal.status).toBe("failed")
		expect(terminal.screening).not.toBeNull()
		expect(terminal.screening?.verdict).toBe("failed")
		expect(terminal.screening?.outputValidation?.ok).toBe(false)
		expect(terminal.screening?.outputValidation?.step).toBe("toolchain")
		const failure = terminal.screening?.outputValidation as
			| { failure?: { toolchain?: string; actionId?: string; exitCode?: number; stderr?: string } }
			| undefined
		expect(failure?.failure?.toolchain).toBe("tsc")
		expect(failure?.failure?.actionId).toBe("gen-ts")
		expect(failure?.failure?.exitCode).not.toBe(0)
		// The stderr must quote the actual diagnostic (the broken
		// TS literal) rather than a generic crash message.
		expect(failure?.failure?.stderr ?? "").toMatch(/index\.ts|number|string/)

		// Bug-signature guard: the verdict payload must not carry
		// `require is not defined` anywhere — that was the exact
		// shape the broken implementation produced when the tsc
		// resolve call crashed the subprocess.
		const serialized = JSON.stringify(terminal)
		expect(serialized).not.toMatch(/require is not defined/i)
	}, 120_000)
})
