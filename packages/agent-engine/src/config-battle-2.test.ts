// ---------------------------------------------------------------------------
// QA battle tests (round 2) for the role-keyed config loader and store.
//
// These tests target gaps the round-1 suite (config.test.ts,
// config-battle.test.ts) missed. They are scoped to the agent-engine
// surface and use vitest (the package's test runner).
//
// Coverage areas (per qa-battle-tester investigation):
//   - The store's corrupt-config error has a `baka: ` prefix that
//     double-prefixes when the CLI's `die()` runs. The engine's
//     loadLLMConfig propagates that error verbatim, so the engine
//     itself can be tested for the prefix. This is a HIGH-severity
//     defect because EVERY call site (baka roles, baka role, baka plan,
//     baka apply, baka validate) renders the doubled prefix.
//   - An empty file at `~/.baka/config.json` (0 bytes) is treated as
//     "corrupt" — the user sees the `baka: baka:` doubled prefix
//     instead of a clean "missing LLM config" message.
//   - A file containing only the JSON literal `null` is treated as
//     gracefully empty (the role block is "not configured"). This is
//     a NON-defect contract test.
//   - Writing the validator role via `writeRoleConfig("validator", X)`
//     must preserve the worker role's block unchanged. This is a
//     defensive contract test (the store does `cfg[role] = block` so
//     the other role is preserved, but a future refactor could break
//     it silently).
//   - readRoleConfig on a missing role returns `undefined`, not `null`
//     or `{}`. This is a contract test.
//   - `loadLLMConfig` MUST set `code: BAKA_CONFIG_MISSING` even on the
//     "unknown role string passed at runtime" path, including the
//     legacy name "orchestrator". This is a contract test.
//
// What it does NOT cover (left for other packages):
//   - CLI surface (apps/cli/test/role-battle-2.test.ts, role-smoke.test.ts)
//   - Worker `baka init` hint (packages/ast-tooling/src/worker-init-message.test.ts)
//   - sdd validator-role LLM contract (modules/sdd/.../validators/*.test.ts)
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isRoleName, readRoleConfig, SUPPORTED_ROLES, writeRoleConfig } from "./config/store.js"
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

function mkHome(prefix: string): string {
	const h = mkdtempSync(join(tmpdir(), prefix))
	tempHomes.push(h)
	process.env.HOME = h
	return h
}

function seedRoleBlock(home: string, role: "worker" | "validator", block: Record<string, unknown>): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	const cfgPath = join(dir, "config.json")
	let cfg: Record<string, unknown> = {}
	try {
		const { readFileSync } = require("node:fs") as typeof import("node:fs")
		cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>
		if (!cfg || typeof cfg !== "object") cfg = {}
	} catch {
		cfg = {}
	}
	cfg[role] = block
	writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
}

// ===========================================================================
// Defect: store's corrupt-config error has a `baka:` prefix that
// double-prefixes when the CLI's die() runs. The engine propagates the
// store error verbatim, so the engine itself can be tested for the prefix.
// ===========================================================================

describe("loadLLMConfig — store error format (no `baka:` prefix in engine errors)", () => {
	it("does NOT include the `baka:` prefix in the error message for a corrupt config.json", async () => {
		const home = mkHome("baka-battle-2-corrupt-")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		// Truncated JSON: guaranteed parse failure.
		writeFileSync(join(dir, "config.json"), '{ "worker": ')

		let caught: Error | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error
		}
		expect(caught, "expected loadLLMConfig to throw on a corrupt config").toBeDefined()
		// The store should NOT prepend `baka:` to its error message —
		// the CLI's `die()` adds it. The engine's contract: errors
		// should be plain English, the CLI handles presentation.
		expect(caught?.message, `unexpected 'baka:' prefix in engine error: ${caught?.message}`).not.toMatch(/^baka:/)
		expect(caught?.message, "engine error should not start with 'baka: '").not.toMatch(/^baka: /)
	})

	it("does NOT include the `baka:` prefix for an empty (0-byte) config.json", async () => {
		const home = mkHome("baka-battle-2-empty-")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		// 0-byte file. The store treats this as "corrupt" and throws.
		writeFileSync(join(dir, "config.json"), "")

		let caught: Error | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error
		}
		expect(caught, "expected loadLLMConfig to throw on an empty config").toBeDefined()
		expect(caught?.message, `unexpected 'baka:' prefix in engine error: ${caught?.message}`).not.toMatch(/^baka:/)
	})

	it("does NOT include the `baka:` prefix for a whitespace-only config.json", async () => {
		const home = mkHome("baka-battle-2-whitespace-")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "config.json"), "   \n\n\t  \n")

		let caught: Error | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error
		}
		expect(caught, "expected loadLLMConfig to throw on a whitespace-only config").toBeDefined()
		expect(caught?.message, `unexpected 'baka:' prefix in engine error: ${caught?.message}`).not.toMatch(/^baka:/)
	})
})

// ===========================================================================
// Defect: an empty file is treated as "corrupt", but the right contract
// for the user is "missing LLM config: worker role not configured" — same
// as if the file didn't exist. The empty-file case is a user-visible
// regression: deleting the file's contents (zeroing the file via `truncate`)
// should NOT promote the error from "missing" to "corrupt".
// ===========================================================================

describe("loadLLMConfig — empty / null-only config file", () => {
	it("treats a 0-byte config.json as `role not configured` (the same error a missing file produces)", async () => {
		const home = mkHome("baka-battle-2-empty-sameas-missing-")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "config.json"), "")

		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught, "expected loadLLMConfig to throw").toBeDefined()
		// The contract: same error shape as the "file absent" path,
		// including the BAKA_CONFIG_MISSING code. The user only sees
		// the "not configured" message + a `baka init` hint.
		expect(caught?.code, `expected BAKA_CONFIG_MISSING code; got ${caught?.code}`).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message, `expected 'not configured' message; got ${caught?.message}`).toMatch(/role not configured/)
		expect(caught?.message, `expected 'baka init' hint; got ${caught?.message}`).toContain("baka init")
		// And NOT the "is corrupt" message — that path is a UX
		// regression that promotes "you have a problem" to "your
		// file is broken" when the file is just empty.
		expect(caught?.message, `unexpected 'corrupt' message for an empty file; got ${caught?.message}`).not.toMatch(
			/corrupt/,
		)
	})

	it("treats a `null`-only config.json as `role not configured`", async () => {
		const home = mkHome("baka-battle-2-null-config-")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "config.json"), "null")

		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught, "expected loadLLMConfig to throw on a null-only config").toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message).toMatch(/role not configured/)
		expect(caught?.message).toContain("baka init")
	})

	it("treats an empty-object config.json (`{}`) as `role not configured`", async () => {
		const home = mkHome("baka-battle-2-empty-obj-")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "config.json"), "{}")

		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught, "expected loadLLMConfig to throw on an empty-object config").toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message).toMatch(/role not configured/)
	})
})

// ===========================================================================
// Defect: a config file containing the legacy `providers` key (e.g. from a
// pre-refactor user) must NOT introduce a `providers` field in the
// resolved config, must NOT shadow the role block, and must NOT throw
// a "corrupt" error. The store reads the file as-is; the engine
// ignores anything that's not a role key.
// ===========================================================================

describe("loadLLMConfig — legacy `providers` shape in config.json", () => {
	it("ignores the legacy `providers` key and surfaces `role not configured` for the worker role", async () => {
		const home = mkHome("baka-battle-2-legacy-providers-")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		// A legacy-shaped file: only `providers`, no role blocks.
		// The new code must NOT throw a parse error and must NOT
		// expose the `providers` key in any downstream view.
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				providers: {
					llama_cpp: {
						baseUrl: "http://localhost:8080/v1",
						model: "gemma4:e4b-it",
						apiKey: "legacy-key",
					},
				},
				activeProvider: "llama_cpp",
				defaults: { temperature: 0, maxTokens: 8192, timeoutMs: 120000 },
			}),
		)

		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught, "expected loadLLMConfig to throw when only the legacy key is present").toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message).toMatch(/worker role not configured/)
		// The legacy `providers` blob must NOT leak into the resolved
		// config. The error path is fine; we also confirm that
		// `readRoleConfig` returns undefined (not the legacy blob).
		expect(readRoleConfig("worker")).toBeUndefined()
		expect(readRoleConfig("validator")).toBeUndefined()
	})
})

// ===========================================================================
// Defect: writeRoleConfig("validator", X) MUST preserve the worker block
// unchanged. If the store implementation regressed (e.g. to a
// `replace-all` semantic), this test catches it.
// ===========================================================================

describe("writeRoleConfig — overlapping-edit contract", () => {
	it("writing the validator role block does not clobber the worker role block", () => {
		const home = mkHome("baka-battle-2-overlap-")
		seedRoleBlock(home, "worker", { baseUrl: "http://worker.example/v1", model: "worker-model", apiKey: "w-key" })
		seedRoleBlock(home, "validator", { baseUrl: "http://v.example/v1", model: "v-model", apiKey: "v-key" })

		const workerBefore = readRoleConfig("worker")
		const validatorBefore = readRoleConfig("validator")
		expect(workerBefore).toBeDefined()
		expect(validatorBefore).toBeDefined()

		// Re-write the validator block with new field values.
		const newValidator = {
			baseUrl: "http://validator-NEW.example/v1",
			model: "validator-NEW-model",
			apiKey: "validator-NEW-key",
			temperature: 0.1,
			maxTokens: 1024,
			timeoutMs: 30_000,
		}
		writeRoleConfig("validator", newValidator)

		// The validator block reflects the new values.
		const validatorAfter = readRoleConfig("validator")
		expect(validatorAfter?.baseUrl).toBe("http://validator-NEW.example/v1")
		expect(validatorAfter?.model).toBe("validator-NEW-model")
		expect(validatorAfter?.apiKey).toBe("validator-NEW-key")

		// The worker block is UNCHANGED.
		const workerAfter = readRoleConfig("worker")
		expect(workerAfter).toEqual(workerBefore)
		expect(workerAfter?.baseUrl).toBe("http://worker.example/v1")
		expect(workerAfter?.model).toBe("worker-model")
		expect(workerAfter?.apiKey).toBe("w-key")
	})

	it("writing the worker role block does not clobber the validator role block", () => {
		const home = mkHome("baka-battle-2-overlap-w-")
		seedRoleBlock(home, "worker", { baseUrl: "http://w.example/v1", model: "wm", apiKey: "wk" })
		seedRoleBlock(home, "validator", { baseUrl: "http://v.example/v1", model: "vm", apiKey: "vk" })

		const validatorBefore = readRoleConfig("validator")
		writeRoleConfig("worker", { baseUrl: "http://worker-NEW.example/v1", model: "wmn", apiKey: "wkn" })

		// Worker is updated.
		const workerAfter = readRoleConfig("worker")
		expect(workerAfter?.baseUrl).toBe("http://worker-NEW.example/v1")
		expect(workerAfter?.model).toBe("wmn")
		// Validator is intact.
		const validatorAfter = readRoleConfig("validator")
		expect(validatorAfter).toEqual(validatorBefore)
	})
})

// ===========================================================================
// Defect: readRoleConfig on a missing role MUST return `undefined`.
// Returning `null` or `{}` would break the `if (!roleBlock) throw ...`
// check in loadLLMConfig and silently produce a corrupt / half-config.
// ===========================================================================

describe("readRoleConfig — missing role shape", () => {
	it("returns `undefined` (not null, not `{}`) for a missing role on a fresh install", () => {
		const _home = mkHome("baka-battle-2-missing-")
		// No config file at all.

		const worker = readRoleConfig("worker")
		const validator = readRoleConfig("validator")

		expect(worker, "readRoleConfig must return undefined for missing worker role").toBeUndefined()
		expect(validator, "readRoleConfig must return undefined for missing validator role").toBeUndefined()
		expect(worker).not.toBeNull()
		expect(validator).not.toBeNull()
	})

	it("returns the role block, not the entire config object", () => {
		const home = mkHome("baka-battle-2-returns-block-")
		seedRoleBlock(home, "worker", { baseUrl: "http://w", model: "wm", apiKey: "wk" })
		seedRoleBlock(home, "validator", { baseUrl: "http://v", model: "vm", apiKey: "vk" })

		const worker = readRoleConfig("worker")
		expect(worker).toBeDefined()
		// The block shape: { baseUrl, model, apiKey } — not a Record<RoleName, ...>.
		expect(worker).toHaveProperty("baseUrl", "http://w")
		expect(worker).toHaveProperty("model", "wm")
		expect(worker).toHaveProperty("apiKey", "wk")
		// And it must NOT carry the validator sibling as a property.
		expect((worker as unknown as Record<string, unknown>).validator).toBeUndefined()
	})
})

// ===========================================================================
// Defect: loadLLMConfig MUST throw with `code: BAKA_CONFIG_MISSING` for
// every error path, INCLUDING the unknown-role string path and the
// "legacy role names" trap (orchestrator, active, openai, llama_cpp).
// The TS type at the call site enforces SUPPORTED_ROLES, but the engine
// is also called via JSON-deserialized paths where the type is erased.
// ===========================================================================

describe("loadLLMConfig — code: BAKA_CONFIG_MISSING on every error path", () => {
	it("attaches the code when the role name is the legacy 'orchestrator'", async () => {
		const _home = mkHome("baka-battle-2-orchestrator-")
		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "orchestrator" as unknown as "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught).toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
	})

	it("attaches the code when the role name is the legacy 'active' (no longer a thing)", async () => {
		const _home = mkHome("baka-battle-2-active-")
		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "active" as unknown as "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught).toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
	})

	it("attaches the code when the role name is a legacy provider alias (e.g. 'openai')", async () => {
		const _home = mkHome("baka-battle-2-openai-")
		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "openai" as unknown as "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught).toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
		expect(caught?.message).toContain("unknown role")
	})

	it("attaches the code when the role name is a kebab-case variant (e.g. 'worker-mod')", async () => {
		const _home = mkHome("baka-battle-2-worker-mod-")
		let caught: (Error & { code?: string }) | undefined
		try {
			await loadLLMConfig({ role: "worker-mod" as unknown as "worker", cwd: "/tmp" })
		} catch (err) {
			caught = err as Error & { code?: string }
		}
		expect(caught).toBeDefined()
		expect(caught?.code).toBe("BAKA_CONFIG_MISSING")
	})
})

// ===========================================================================
// Defect: isRoleName MUST reject every name that is not literally one of
// SUPPORTED_ROLES. This includes case-variants ("Worker"), adjacent
// names ("validator-judge", "worker-mod"), legacy names ("orchestrator",
// "active", "openai", "llama_cpp"), and the empty string. If any of
// these slip through, loadLLMConfig would crash with a different error
// (or silently return the wrong block).
// ===========================================================================

describe("isRoleName — exhaustive rejection list", () => {
	it("rejects every name that is not literally in SUPPORTED_ROLES", () => {
		const rejected = [
			"Worker", // case variant of "worker"
			"WORKER", // all caps
			"Validator", // case variant
			"VALIDATOR",
			"judge", // hypothetical future role
			"validator-judge", // kebab-case sibling
			"worker-mod", // kebab-case sibling
			"worker_validator", // snake-case sibling
			"orchestrator", // legacy role
			"active", // legacy role
			"openai", // legacy provider alias
			"llama_cpp", // legacy provider alias
			"ollama", // legacy provider alias
			"vllm", // legacy provider alias
			"openai-compatible", // legacy provider alias
			"", // empty string
			" ", // whitespace
			"worker ", // trailing whitespace
			" worker", // leading whitespace
		]
		for (const bad of rejected) {
			expect(isRoleName(bad), `expected '${bad}' to be rejected by isRoleName`).toBe(false)
		}
	})

	it("accepts exactly the SUPPORTED_ROLES union and nothing else", () => {
		expect(SUPPORTED_ROLES).toEqual(["worker", "validator"])
		for (const role of SUPPORTED_ROLES) {
			expect(isRoleName(role), `expected '${role}' to be accepted`).toBe(true)
		}
		// And the total count of accepted names is exactly the size of the union.
		const accepted: string[] = []
		for (const candidate of ["worker", "validator", "judge", "orchestrator", "active", "openai", ""]) {
			if (isRoleName(candidate)) accepted.push(candidate)
		}
		expect(accepted).toEqual(["worker", "validator"])
	})
})
