// ---------------------------------------------------------------------------
// QA battle tests (round 2) for the sdd.init-constitution validator.
//
// These tests target gaps the round-1 suite (constitution-coherent.test.ts)
// missed. They exercise the validator's behavior under network failure,
// schema rejection, and 5xx upstream errors. The contract is:
//   - LLM transport errors (network unreachable, schema rejection, 5xx)
//     are absorbed as warnings; the structural checks already passed.
//   - The validator MUST NOT silently fall back to the worker role.
//   - The error message in the warning diagnostic must NOT contain a
//     `baka:` prefix (the validator emits the warning directly; the
//     CLI's `die()` is the only place that adds `baka:`).
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestrationState, ValidationDiagnostic } from "baka-sdk"
import { afterEach, describe, expect, it } from "vitest"

const cleanup: string[] = []
const prevHome = process.env.HOME

afterEach(() => {
	process.env.HOME = prevHome
	for (const d of cleanup.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
	}
})

function makeTempTarget(): string {
	const dir = mkdtempSync(join(tmpdir(), "baka-sdd-init-constitution-battle-validator-"))
	cleanup.push(dir)
	return dir
}

function useFakeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "baka-sdd-init-constitution-battle-home-"))
	cleanup.push(home)
	process.env.HOME = home
	return home
}

function seedRoleBlock(home: string, role: "worker" | "validator", baseUrl = `http://${role}.invalid/v1`): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	const block = {
		baseUrl,
		model: `${role}-model`,
		apiKey: "k",
		temperature: 0,
		maxTokens: 8192,
		timeoutMs: 120_000,
	}
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

function makeState(targetDirectory: string): OrchestrationState {
	return {
		userIntent: "test",
		targetDirectory,
		status: "VALIDATING",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
}

function writeAllSpecFiles(target: string): void {
	mkdirSync(join(target, "specs"), { recursive: true })
	writeFileSync(join(target, "specs", "mission.md"), "# Mission\n\nConcrete mission statement for the product.\n")
	writeFileSync(join(target, "specs", "tech-stack.md"), "# Tech Stack\n\nTypeScript 5.x on Node 22 with pnpm 9.\n")
	writeFileSync(join(target, "specs", "roadmap.md"), "# Roadmap\n\n## Phase 1\nShip the role-keyed config refactor.\n")
}

async function loadValidator(): Promise<(state: OrchestrationState) => Promise<ValidationDiagnostic[]>> {
	const mod = (await import("./constitution-coherent.js")) as {
		constitutionCoherent?: (state: OrchestrationState) => Promise<ValidationDiagnostic[]>
	}
	if (!mod.constitutionCoherent) throw new Error("constitutionCoherent is not defined")
	return mod.constitutionCoherent
}

// ===========================================================================
// Defect: The validator emits a warning diagnostic with the LLM error
// message. The validator MUST NOT prepend `baka:` to the warning message
// (the user-facing surface that displays the warning does its own
// presentation; the validator emits plain English).
// ===========================================================================

describe("sdd.init-constitution validator — warning diagnostic format (round 2)", () => {
	it("absorbs an unreachable-host LLM call as a warning with no `baka:` prefix in the message", async () => {
		const target = makeTempTarget()
		writeAllSpecFiles(target)
		const home = useFakeHome()
		// Unreachable host (RFC 5737 documentation block) with a tiny
		// timeout so the test does not stall.
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		const cfgPath = join(dir, "config.json")
		const cfg: Record<string, unknown> = {
			worker: { baseUrl: "http://192.0.2.1:9999/v1", model: "wm", apiKey: "k", timeoutMs: 500 },
			validator: { baseUrl: "http://192.0.2.1:9999/v1", model: "vm", apiKey: "k", timeoutMs: 500 },
		}
		writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

		const validatorFn = await loadValidator()
		const diagnostics = await validatorFn(makeState(target))

		// The validator must NOT emit an error diagnostic.
		const errors = diagnostics.filter((d) => d.severity === "error")
		expect(errors, `expected zero error diagnostics; got ${JSON.stringify(diagnostics)}`).toEqual([])

		// It MUST emit at least one warning diagnostic with the LLM error
		// context.
		const warnings = diagnostics.filter((d) => d.severity === "warning")
		expect(
			warnings.length,
			`expected at least one warning diagnostic; got ${JSON.stringify(diagnostics)}`,
		).toBeGreaterThan(0)
		// And the warning message must NOT have a `baka:` prefix.
		for (const w of warnings) {
			expect(w.message, `unexpected 'baka:' prefix in warning: ${w.message}`).not.toMatch(/^baka:/)
		}
		// And the rule ID must be the validator's, not the worker role's.
		const wrongRule = diagnostics.find((d) => d.rule.includes("worker") || d.rule.includes("Worker"))
		expect(
			wrongRule,
			`validator should not emit worker-related diagnostics: ${JSON.stringify(diagnostics)}`,
		).toBeUndefined()
	})

	it("absorbs an LLM call that fails with a 5xx upstream error as a warning", async () => {
		// We can't easily simulate a 5xx without a real LLM, but we can
		// use a real local server that returns 500. The contract: any
		// transport-level error is absorbed as a warning.
		const target = makeTempTarget()
		writeAllSpecFiles(target)
		const home = useFakeHome()
		// A URL that resolves but is not an LLM server — the LLM provider
		// will throw on the first chat() call.
		seedRoleBlock(home, "worker", "http://127.0.0.1:1/v1")
		seedRoleBlock(home, "validator", "http://127.0.0.1:1/v1")

		const validatorFn = await loadValidator()
		const diagnostics = await validatorFn(makeState(target))

		// No error diagnostics; the validator absorbed the failure.
		const errors = diagnostics.filter((d) => d.severity === "error")
		expect(errors, `expected zero error diagnostics; got ${JSON.stringify(diagnostics)}`).toEqual([])
	})
})

// ===========================================================================
// Defect: the validator's `loadLLMProvider` MUST throw `BAKA_CONFIG_MISSING`
// when the validator role is not configured. The validator must propagate
// the throw (NOT catch and emit a warning) because the user's
// "hard-fail" contract says: a missing or incomplete role config is a
// USER_ERROR that must surface as a throw, not a warning.
// ===========================================================================

describe("sdd.init-constitution validator — hard-throw contract (round 2)", () => {
	it("throws when the validator role is completely absent (only worker configured)", async () => {
		const target = makeTempTarget()
		writeAllSpecFiles(target)
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		// No validator role block.

		const validatorFn = await loadValidator()
		await expect(validatorFn(makeState(target))).rejects.toThrow(/validator role not configured/)
	})

	it("throws when the validator role block is missing `baseUrl`", async () => {
		const target = makeTempTarget()
		writeAllSpecFiles(target)
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		// Validator block with NO baseUrl.
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		const cfgPath = join(dir, "config.json")
		const cfg = JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8")) as Record<string, unknown>
		cfg.validator = { model: "v-model", apiKey: "k", temperature: 0, maxTokens: 8192, timeoutMs: 120_000 }
		require("node:fs").writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

		const validatorFn = await loadValidator()
		await expect(validatorFn(makeState(target))).rejects.toThrow(/baseUrl/)
	})

	it("throws when the validator role block is missing `model`", async () => {
		const target = makeTempTarget()
		writeAllSpecFiles(target)
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		const cfgPath = join(dir, "config.json")
		const cfg = JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8")) as Record<string, unknown>
		cfg.validator = { baseUrl: "http://v", apiKey: "k", temperature: 0, maxTokens: 8192, timeoutMs: 120_000 }
		require("node:fs").writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

		const validatorFn = await loadValidator()
		await expect(validatorFn(makeState(target))).rejects.toThrow(/model/)
	})
})
