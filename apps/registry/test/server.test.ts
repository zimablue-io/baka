import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/config"
import { startServer } from "../src/server"

/**
 * Integration test: the documented bootstrap path. Boots the Hono app on
 * a real port via `@hono/node-server`, hits `/healthz` with curl-style
 * `fetch`, and confirms the schema_version file was written to the data dir.
 *
 * The port is ephemeral (`PORT=0` → OS-assigned) so this test never races
 * with another listener on the box and never needs the manifest port (4300).
 */

function makeTmpDataDir(): string {
	return mkdtempSync(join(tmpdir(), "baka-registry-server-"))
}

let dataDir: string

beforeEach(() => {
	dataDir = makeTmpDataDir()
})

afterEach(async () => {
	rmSync(dataDir, { recursive: true, force: true })
})

describe("startServer", () => {
	function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
		// Explicit reset so a stale BASE_URL or PORT from the test runner env
		// cannot leak into the schema-config validation below.
		return {
			PORT: "0",
			BASE_URL: "http://localhost:4300",
			DATA_DIR: dataDir,
			STORAGE_DIR: "artifacts",
			PGLITE_DIR: "pg",
			PGLITE_SOCKET_PORT: "5444",
			...overrides,
		}
	}

	it("binds to the configured port and serves GET /healthz", async () => {
		const config = loadConfig(env(), dataDir)

		const handle = await startServer(config)
		try {
			const res = await fetch(`${handle.url()}/healthz`)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { status: string }
			expect(body).toEqual({ status: "ok" })
		} finally {
			await handle.close()
		}
	})

	it("writes schema_version into the data dir at boot", async () => {
		const config = loadConfig(env(), dataDir)

		const handle = await startServer(config)
		try {
			const recorded = readFileSync(join(dataDir, "schema_version"), "utf8").trim()
			// The data-layer feature bumps schema_version to "2" so the app
			// schema (modules, module_versions, artifacts, screening_results,
			// plan_limits) is migrated at boot. The scaffold's v1 has no
			// app tables yet.
			expect(recorded).toBe("2")
		} finally {
			await handle.close()
		}
	})

	it("refuses to boot (process.exit) when the data dir has a newer schema_version", async () => {
		// Seed a newer version than the binary supports, then expect startServer
		// to invoke process.exit(1) BEFORE returning. We intercept the exit.
		const newerVersion = "999"
		const seedPath = join(dataDir, "schema_version")
		const { writeFileSync } = require("node:fs") as typeof import("node:fs")
		writeFileSync(seedPath, `${newerVersion}\n`, "utf8")

		const originalExit = process.exit
		let exitCode: number | null = null
		process.exit = ((code: number) => {
			exitCode = code
			throw new Error(`__process_exit_${code}__`)
		}) as typeof process.exit

		const config = loadConfig(env(), dataDir)

		try {
			await expect(startServer(config)).rejects.toThrow(/__process_exit_1__/)
			expect(exitCode).toBe(1)
		} finally {
			process.exit = originalExit
		}

		// The recorded newer version is preserved (forward-only).
		expect(readFileSync(seedPath, "utf8").trim()).toBe(newerVersion)
	})
})
