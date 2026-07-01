// ---------------------------------------------------------------------------
// Tests for the sdd.create-feature validator-role LLM validator
// (`featureSpecCoherent`).
//
// Validator file location: ./feature-spec-coherent.js (relative to this
// test file). The validator exports `featureSpecCoherent(state)` and
// returns an array of validation diagnostics.
//
// Contract under test (mirror of constitutionCoherent):
//   - All 3 spec files exist in `specs/<YYYY-MM-DD>-<name>/`
//     (`plan.md`, `requirements.md`, `validation.md`) AND each has
//     non-stub content AND the validator-role LLM returns coherent:true
//     → validator returns [].
//   - Any spec file missing → validator emits an error diagnostic with
//     rule `sdd.create-feature:featureSpecCoherent` whose message
//     names the missing file(s).
//   - A spec file containing the placeholder body → validator emits an
//     error diagnostic.
//   - Validator returns coherent:false with issues[] → validator emits
//     one warning diagnostic per issue.
//   - Validator routes to the validator-role LLM via
//     `baka-sdk.callLLMAsValidator`.
//
// These tests are written BEFORE the implementation lands, so the import
// of `./feature-spec-coherent.js` will throw ERR_MODULE_NOT_FOUND.
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
	const dir = mkdtempSync(join(tmpdir(), "baka-sdd-create-feature-validator-"))
	cleanup.push(dir)
	return dir
}

function useFakeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "baka-sdd-create-feature-home-"))
	cleanup.push(home)
	process.env.HOME = home
	return home
}

function seedRoleBlock(home: string, role: "worker" | "validator"): void {
	const dir = join(home, ".baka")
	mkdirSync(dir, { recursive: true })
	const block = {
		baseUrl: `http://${role}.invalid/v1`,
		model: `${role}-model`,
		apiKey: "k",
		temperature: 0,
		maxTokens: 8192,
		timeoutMs: 120_000,
	}
	const cfg = role === "worker" ? { worker: block } : { validator: block }
	writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2))
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

/** Real-shaped non-stub content for all 3 feature spec files. */
function writeAllFeatureSpecFiles(target: string): void {
	mkdirSync(join(target, FEATURE_DIR), { recursive: true })
	writeFileSync(join(target, FEATURE_DIR, "plan.md"), "# Plan\n\nConcrete plan content for the feature.\n")
	writeFileSync(join(target, FEATURE_DIR, "requirements.md"), "# Requirements\n\nConcrete requirements list.\n")
	writeFileSync(join(target, FEATURE_DIR, "validation.md"), "# Validation\n\nConcrete validation contract.\n")
}

/** Load the validator once; the helper centralizes the import + null-check. */
async function loadValidator(): Promise<(state: OrchestrationState) => Promise<ValidationDiagnostic[]>> {
	const mod = (await import("./feature-spec-coherent.js")) as {
		featureSpecCoherent?: (state: OrchestrationState) => Promise<ValidationDiagnostic[]>
	}
	expect(mod.featureSpecCoherent, "validators/feature-spec-coherent.ts must export `featureSpecCoherent`").toBeDefined()
	if (!mod.featureSpecCoherent) {
		throw new Error("featureSpecCoherent is not defined")
	}
	return mod.featureSpecCoherent
}

describe("sdd.create-feature validator: featureSpecCoherent", () => {
	it("emits no error diagnostics on non-stub content (validator absorbs LLM unreachability as a warning)", async () => {
		const target = makeTempTarget()
		writeAllFeatureSpecFiles(target)

		// Seed a validator role that points at an unreachable host.
		// The validator must then absorb the LLM unreachability as a
		// warning (not an error) once the structural checks pass.
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		seedRoleBlock(home, "validator")

		const validatorFn = await loadValidator()
		const diagnostics = await validatorFn(makeState(target))

		const errors = diagnostics.filter(
			(d) => d.severity === "error" && d.rule === "sdd.create-feature:featureSpecCoherent",
		)
		expect(errors, `expected zero error diagnostics on non-stub content; got ${JSON.stringify(diagnostics)}`).toEqual(
			[],
		)
	})

	it("emits an error diagnostic (rule sdd.create-feature:featureSpecCoherent) when any spec file is missing", async () => {
		const target = makeTempTarget()
		mkdirSync(join(target, FEATURE_DIR), { recursive: true })
		writeFileSync(join(target, FEATURE_DIR, "plan.md"), "# Plan\n\nConcrete content.\n")
		// requirements.md and validation.md absent.
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		seedRoleBlock(home, "validator")

		const validatorFn = await loadValidator()
		const diagnostics = await validatorFn(makeState(target))

		const matched = diagnostics.find((d) => d.rule === "sdd.create-feature:featureSpecCoherent")
		expect(matched, `expected a diagnostic; got ${JSON.stringify(diagnostics)}`).toBeDefined()
		expect(matched?.severity).toBe("error")
		expect(matched?.message ?? "").toMatch(/requirements\.md|validation\.md/)
	})

	it("emits an error diagnostic when a spec file is the placeholder body", async () => {
		const target = makeTempTarget()
		mkdirSync(join(target, FEATURE_DIR), { recursive: true })
		writeFileSync(join(target, FEATURE_DIR, "plan.md"), `# ${FEATURE_NAME} — Plan\n\n_TBD_\n`)
		writeFileSync(join(target, FEATURE_DIR, "requirements.md"), `# ${FEATURE_NAME} — Requirements\n\n_TBD_\n`)
		writeFileSync(join(target, FEATURE_DIR, "validation.md"), `# ${FEATURE_NAME} — Validation\n\n_TBD_\n`)
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		seedRoleBlock(home, "validator")

		const validatorFn = await loadValidator()
		const diagnostics = await validatorFn(makeState(target))

		const error = diagnostics.find((d) => d.severity === "error" && d.rule === "sdd.create-feature:featureSpecCoherent")
		expect(error, `expected an error diagnostic for the placeholder; got ${JSON.stringify(diagnostics)}`).toBeDefined()
	})

	it("calls the validator-role LLM (not the worker role)", async () => {
		const target = makeTempTarget()
		writeAllFeatureSpecFiles(target)

		const home = useFakeHome()
		seedRoleBlock(home, "worker")

		const validatorFn = await loadValidator()
		await expect(validatorFn(makeState(target))).rejects.toThrow(/validator role not configured/)
	})
})
