// ---------------------------------------------------------------------------
// QA battle tests (round 2) for the sdd.create-feature validator.
//
// These tests target gaps the round-1 suite (feature-spec-coherent.test.ts)
// missed. They exercise the validator's behavior under network failure
// and the hard-throw contract for missing role config. The contract is:
//   - LLM transport errors (network unreachable, schema rejection, 5xx)
//     are absorbed as warnings.
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
	const dir = mkdtempSync(join(tmpdir(), "baka-sdd-create-feature-battle-validator-"))
	cleanup.push(dir)
	return dir
}

function useFakeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "baka-sdd-create-feature-battle-home-"))
	cleanup.push(home)
	process.env.HOME = home
	return home
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

const TODAY = new Date().toISOString().slice(0, 10)
const FEATURE_NAME = "role-keyed-config"
const FEATURE_DIR = `specs/${TODAY}-${FEATURE_NAME}`

function writeAllFeatureSpecFiles(target: string): void {
	mkdirSync(join(target, FEATURE_DIR), { recursive: true })
	writeFileSync(join(target, FEATURE_DIR, "plan.md"), "# Plan\n\nConcrete plan content for the feature.\n")
	writeFileSync(join(target, FEATURE_DIR, "requirements.md"), "# Requirements\n\nConcrete requirements list.\n")
	writeFileSync(join(target, FEATURE_DIR, "validation.md"), "# Validation\n\nConcrete validation contract.\n")
}

async function loadValidator(): Promise<(state: OrchestrationState) => Promise<ValidationDiagnostic[]>> {
	const mod = (await import("./feature-spec-coherent.js")) as {
		featureSpecCoherent?: (state: OrchestrationState) => Promise<ValidationDiagnostic[]>
	}
	if (!mod.featureSpecCoherent) throw new Error("featureSpecCoherent is not defined")
	return mod.featureSpecCoherent
}

// ===========================================================================
// Defect: The validator emits a warning diagnostic with the LLM error
// message. The validator MUST NOT prepend `baka:` to the warning message.
// ===========================================================================

describe("sdd.create-feature validator — warning diagnostic format (round 2)", () => {
	it("absorbs an unreachable-host LLM call as a warning with no `baka:` prefix in the message", async () => {
		const target = makeTempTarget()
		writeAllFeatureSpecFiles(target)
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
})

// ===========================================================================
// Defect: the validator's `loadLLMProvider` MUST throw `BAKA_CONFIG_MISSING`
// when the validator role is not configured. The validator must propagate
// the throw (NOT catch and emit a warning).
// ===========================================================================

describe("sdd.create-feature validator — hard-throw contract (round 2)", () => {
	it("throws when the validator role is completely absent (only worker configured)", async () => {
		const target = makeTempTarget()
		writeAllFeatureSpecFiles(target)
		const home = useFakeHome()
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		const cfgPath = join(dir, "config.json")
		const cfg: Record<string, unknown> = {
			worker: { baseUrl: "http://w", model: "wm", apiKey: "k" },
		}
		writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

		const validatorFn = await loadValidator()
		await expect(validatorFn(makeState(target))).rejects.toThrow(/validator role not configured/)
	})

	it("throws when the validator role block is missing `baseUrl`", async () => {
		const target = makeTempTarget()
		writeAllFeatureSpecFiles(target)
		const home = useFakeHome()
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		const cfgPath = join(dir, "config.json")
		const cfg: Record<string, unknown> = {
			worker: { baseUrl: "http://w", model: "wm", apiKey: "k" },
			validator: { model: "vm", apiKey: "k", temperature: 0, maxTokens: 8192, timeoutMs: 120_000 },
		}
		writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

		const validatorFn = await loadValidator()
		await expect(validatorFn(makeState(target))).rejects.toThrow(/baseUrl/)
	})

	it("throws when the validator role block is missing `model`", async () => {
		const target = makeTempTarget()
		writeAllFeatureSpecFiles(target)
		const home = useFakeHome()
		const dir = join(home, ".baka")
		mkdirSync(dir, { recursive: true })
		const cfgPath = join(dir, "config.json")
		const cfg: Record<string, unknown> = {
			worker: { baseUrl: "http://w", model: "wm", apiKey: "k" },
			validator: { baseUrl: "http://v", apiKey: "k", temperature: 0, maxTokens: 8192, timeoutMs: 120_000 },
		}
		writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

		const validatorFn = await loadValidator()
		await expect(validatorFn(makeState(target))).rejects.toThrow(/model/)
	})
})
