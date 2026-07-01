// ---------------------------------------------------------------------------
// QA battle tests for the role-keyed config loader.
//
// These tests were written by qa-battle-tester to cover defects the writer
// missed in packages/agent-engine/src/index.ts (loadLLMConfig) and
// ./config/store.ts. They are intentionally scoped to the agent-engine
// surface and use vitest (the package's test runner).
//
// Coverage areas (per qa-battle-tester investigation):
//   - Missing apiKey field: loadLLMConfig MUST succeed (apiKey is optional
//     per the documented contract for local servers), and the resolved
//     config carries apiKey="". This pins the contract that the
//     `local servers may run with no key` invariant stays intact.
//   - `code: BAKA_CONFIG_MISSING` is set on every error path (missing
//     role block, missing baseUrl, missing model, unknown role string
//     passed at runtime). Downstream code surfaces this code in the
//     diagnostic to drive CLI exit-code selection.
//   - `isRoleName` rejects role strings outside the SUPPORTED_ROLES
//     union at runtime, even when a caller bypasses the TS type.
//   - writeRoleConfig with `undefined` deletes the role block entirely
//     (and the role is then `not configured` per readRoleConfig).
//
// What it does NOT cover (left for other packages):
//   - CLI surface (apps/cli/test/role-smoke.test.ts, cli-smoke.test.ts)
//   - Worker `baka init` hint (packages/ast-tooling/src/worker-init-message.test.ts)
//   - sdd validator-role LLM contract (modules/sdd/.../validators/*.test.ts)
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isRoleName, listRoles, readRoleConfig, SUPPORTED_ROLES, writeRoleConfig } from "./config/store.js"
import { loadLLMConfig } from "./index"

const prevHome = process.env.HOME
const tempHomes: string[] = []

afterEach(() => {
	process.env.HOME = prevHome
	for (const d of tempHomes.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function seedRoleBlock(home: string, role: "worker" | "validator", block: Record<string, unknown>): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	const cfgPath = join(dir, "config.json")
	let cfg: Record<string, unknown> = {}
	try {
		const existing = JSON.parse(
			// read whatever's already on disk; fall through to {} on parse failure
			require("node:fs").readFileSync(cfgPath, "utf-8"),
		) as Record<string, unknown>
		cfg = existing ?? {}
	} catch {
		cfg = {}
	}
	cfg[role] = block
	writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
}

function mkHome(prefix: string): string {
	const h = mkdtempSync(join(tmpdir(), prefix))
	tempHomes.push(h)
	process.env.HOME = h
	return h
}

// ---------------------------------------------------------------------------
// Defect C: loadLLMConfig must set `code: BAKA_CONFIG_MISSING` on every error
// ---------------------------------------------------------------------------

describe("loadLLMConfig — error code contract", () => {
	it("attaches code: BAKA_CONFIG_MISSING when the role block is absent", async () => {
		const _home = mkHome("baka-battle-code-missing-")
		// No config file at all.

		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught, "expected loadLLMConfig to throw when no role block is present").toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
	})

	it("attaches code: BAKA_CONFIG_MISSING when baseUrl is empty", async () => {
		const home = mkHome("baka-battle-code-nobaseurl-")
		seedRoleBlock(home, "worker", { model: "m", apiKey: "k", temperature: 0, maxTokens: 1, timeoutMs: 1 })

		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught).toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
	})

	it("attaches code: BAKA_CONFIG_MISSING when model is empty", async () => {
		const home = mkHome("baka-battle-code-nomodel-")
		seedRoleBlock(home, "validator", {
			baseUrl: "http://x",
			apiKey: "k",
			temperature: 0,
			maxTokens: 1,
			timeoutMs: 1,
		})

		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "validator", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught).toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
	})

	it("attaches code: BAKA_CONFIG_MISSING when an unknown role string is passed at runtime", async () => {
		const _home = mkHome("baka-battle-code-unknownrole-")

		let caught: (Error & { code?: string }) | undefined
		// Bypass the TS type to test the runtime guard. The union type
		// would prevent this at compile time but the loader is also
		// called via JSON-deserialized paths where the type is erased.
		try {
			await loadLLMConfig({ role: "orchestrator" as unknown as "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught).toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message).toContain("unknown role")
	})
})

// ---------------------------------------------------------------------------
// Defect B: loadLLMConfig must accept a role block with no apiKey (the
// documented contract for local servers). The resolved apiKey is "".
// ---------------------------------------------------------------------------

describe("loadLLMConfig — local-server contract (apiKey optional)", () => {
	it("does NOT throw when the worker block has baseUrl + model but no apiKey", async () => {
		const home = mkHome("baka-battle-noapikey-")
		seedRoleBlock(home, "worker", { baseUrl: "http://127.0.0.1:8080/v1", model: "local-model" })

		const config = await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		expect(config.baseUrl).toBe("http://127.0.0.1:8080/v1")
		expect(config.model).toBe("local-model")
		// Resolved apiKey is the empty string (the documented default).
		expect(config.apiKey).toBe("")
	})

	it("does NOT throw when the validator block has baseUrl + model but no apiKey", async () => {
		const home = mkHome("baka-battle-noapikey-validator-")
		seedRoleBlock(home, "validator", { baseUrl: "http://127.0.0.1:8081/v1", model: "local-validator" })

		const config = await loadLLMConfig({ role: "validator", cwd: "/tmp" })
		expect(config.baseUrl).toBe("http://127.0.0.1:8081/v1")
		expect(config.model).toBe("local-validator")
		expect(config.apiKey).toBe("")
	})

	it("falls back to documented defaults for temperature/maxTokens/timeoutMs when not provided", async () => {
		const home = mkHome("baka-battle-numeric-defaults-")
		seedRoleBlock(home, "worker", { baseUrl: "http://x", model: "m" })

		const config = await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		expect(config.temperature).toBe(0.0)
		expect(config.maxTokens).toBe(8192)
		expect(config.timeoutMs).toBe(120_000)
	})

	it("stamps providerOptions.role so the provider can branch on the role", async () => {
		const home = mkHome("baka-battle-provideroptions-")
		seedRoleBlock(home, "validator", { baseUrl: "http://x", model: "m" })

		const config = await loadLLMConfig({ role: "validator", cwd: "/tmp" })
		expect(config.providerOptions).toBeDefined()
		expect(config.providerOptions?.role).toBe("validator")
	})
})

// ---------------------------------------------------------------------------
// isRoleName / store shape
// ---------------------------------------------------------------------------

describe("isRoleName — runtime gate", () => {
	it("accepts every value in SUPPORTED_ROLES", () => {
		for (const role of SUPPORTED_ROLES) {
			expect(isRoleName(role), `expected ${role} to be a valid role name`).toBe(true)
		}
	})

	it("rejects unknown role strings (including case variants and legacy 'active' / 'orchestrator')", () => {
		for (const bad of ["Orchestrator", "WORKER", "validator-role", "active", "openai", "llama_cpp", ""]) {
			expect(isRoleName(bad), `expected '${bad}' to be rejected`).toBe(false)
		}
	})
})

// ---------------------------------------------------------------------------
// writeRoleConfig(role, undefined) — deletes the role block
// ---------------------------------------------------------------------------

describe("writeRoleConfig — delete contract", () => {
	it("removes the role block entirely when called with `undefined`", () => {
		const home = mkHome("baka-battle-write-delete-")
		seedRoleBlock(home, "worker", { baseUrl: "http://x", model: "m", apiKey: "k" })
		expect(readRoleConfig("worker")).toBeDefined()

		writeRoleConfig("worker", undefined)

		expect(readRoleConfig("worker")).toBeUndefined()
		// Validator block must still be intact — deleting one role
		// must not touch the other.
		seedRoleBlock(home, "validator", { baseUrl: "http://y", model: "vm", apiKey: "vk" })
		expect(readRoleConfig("validator")).toBeDefined()
		writeRoleConfig("worker", undefined)
		expect(readRoleConfig("validator")).toBeDefined()
	})

	it("listRoles omits the deleted role after writeRoleConfig(role, undefined)", () => {
		const home = mkHome("baka-battle-write-list-")
		seedRoleBlock(home, "worker", { baseUrl: "http://x", model: "m", apiKey: "k" })
		seedRoleBlock(home, "validator", { baseUrl: "http://y", model: "vm", apiKey: "vk" })

		expect(
			listRoles()
				.map((r) => r.role)
				.sort(),
		).toEqual(["validator", "worker"])
		writeRoleConfig("worker", undefined)
		expect(listRoles().map((r) => r.role)).toEqual(["validator"])
	})
})
