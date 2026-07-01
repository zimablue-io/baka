// ---------------------------------------------------------------------------
// Tests for the sdd.init-constitution validator-role LLM validator
// (`constitutionCoherent`).
//
// Validator file location: ./constitution-coherent.js (relative to this
// test file). The validator exports `constitutionCoherent(state)` and
// returns an array of validation diagnostics.
//
// Contract under test:
//   - All 3 spec files exist (`mission.md`, `tech-stack.md`, `roadmap.md`)
//     AND each has non-stub content AND the validator-role LLM returns
//     coherent:true → validator returns [] (no diagnostics).
//   - Any spec file missing → validator emits an error diagnostic with
//     rule `sdd.init-constitution:constitutionCoherent` whose message
//     names the missing file(s).
//   - A spec file containing the placeholder body → validator emits an
//     error diagnostic.
//   - Validator returns coherent:false with issues[] → validator emits
//     one warning diagnostic per issue (rule prefix preserved).
//   - Validator routes to the validator-role LLM via
//     `baka-sdk.callLLMAsValidator`. With only the worker role configured,
//     the call throws (the validator must NOT silently fall back to the
//     worker).
//
// These tests are written BEFORE the implementation lands, so the import
// of `./constitution-coherent.js` will throw ERR_MODULE_NOT_FOUND.
// That's the contract: the test fails for the right reason.
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
	const dir = mkdtempSync(join(tmpdir(), "baka-sdd-init-constitution-validator-"))
	cleanup.push(dir)
	return dir
}

function useFakeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "baka-sdd-init-constitution-home-"))
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

/** Real-shaped non-stub content for each of the 3 spec files. */
function writeAllSpecFiles(target: string): void {
	mkdirSync(join(target, "specs"), { recursive: true })
	writeFileSync(join(target, "specs", "mission.md"), "# Mission\n\nConcrete mission statement for the product.\n")
	writeFileSync(join(target, "specs", "tech-stack.md"), "# Tech Stack\n\nTypeScript 5.x on Node 22 with pnpm 9.\n")
	writeFileSync(join(target, "specs", "roadmap.md"), "# Roadmap\n\n## Phase 1\nShip the role-keyed config refactor.\n")
}

/** Load the validator once; the helper centralizes the import + null-check. */
async function loadValidator(): Promise<(state: OrchestrationState) => Promise<ValidationDiagnostic[]>> {
	const mod = (await import("./constitution-coherent.js")) as {
		constitutionCoherent?: (state: OrchestrationState) => Promise<ValidationDiagnostic[]>
	}
	expect(
		mod.constitutionCoherent,
		"validators/constitution-coherent.ts must export `constitutionCoherent`",
	).toBeDefined()
	if (!mod.constitutionCoherent) {
		throw new Error("constitutionCoherent is not defined")
	}
	return mod.constitutionCoherent
}

describe("sdd.init-constitution validator: constitutionCoherent", () => {
	it("emits no error diagnostics on non-stub content (validator absorbs LLM unreachability as a warning)", async () => {
		const target = makeTempTarget()
		writeAllSpecFiles(target)

		// Seed a validator role that points at an unreachable host.
		// The validator must then absorb the LLM unreachability as a
		// warning (not an error) once the structural checks pass.
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		seedRoleBlock(home, "validator")

		const validatorFn = await loadValidator()
		const diagnostics = await validatorFn(makeState(target))

		const errors = diagnostics.filter(
			(d) => d.severity === "error" && d.rule === "sdd.init-constitution:constitutionCoherent",
		)
		expect(errors, `expected zero error diagnostics on non-stub content; got ${JSON.stringify(diagnostics)}`).toEqual(
			[],
		)
	})

	it("emits an error diagnostic (rule sdd.init-constitution:constitutionCoherent) when any spec file is missing", async () => {
		const target = makeTempTarget()
		mkdirSync(join(target, "specs"), { recursive: true })
		writeFileSync(join(target, "specs", "mission.md"), "# Mission\n\nConcrete content.\n")
		// tech-stack.md and roadmap.md absent.
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		seedRoleBlock(home, "validator")

		const validatorFn = await loadValidator()
		const diagnostics = await validatorFn(makeState(target))

		const matched = diagnostics.find((d) => d.rule === "sdd.init-constitution:constitutionCoherent")
		expect(matched, `expected a diagnostic; got ${JSON.stringify(diagnostics)}`).toBeDefined()
		expect(matched?.severity).toBe("error")
		expect(matched?.message ?? "").toMatch(/tech-stack\.md|roadmap\.md/)
	})

	it("emits an error diagnostic when a spec file is the placeholder body", async () => {
		const target = makeTempTarget()
		mkdirSync(join(target, "specs"), { recursive: true })
		writeFileSync(join(target, "specs", "mission.md"), "# Foo — Mission\n\n_TBD_\n")
		writeFileSync(join(target, "specs", "tech-stack.md"), "# Foo — Tech Stack\n\n(not yet decided)\n")
		writeFileSync(join(target, "specs", "roadmap.md"), "# Foo — Roadmap\n\n## Phase 1\n- TBD\n")
		const home = useFakeHome()
		seedRoleBlock(home, "worker")
		seedRoleBlock(home, "validator")

		const validatorFn = await loadValidator()
		const diagnostics = await validatorFn(makeState(target))

		const error = diagnostics.find(
			(d) => d.severity === "error" && d.rule === "sdd.init-constitution:constitutionCoherent",
		)
		expect(error, `expected an error diagnostic for the placeholder; got ${JSON.stringify(diagnostics)}`).toBeDefined()
	})

	it("calls the validator-role LLM (not the worker role)", async () => {
		const target = makeTempTarget()
		writeAllSpecFiles(target)

		// Seed only the worker role. The validator must hit
		// baka-sdk.callLLMAsValidator({ cwd: target, ... })
		// and the underlying loader must throw `missing LLM config:
		// validator role not configured` (not silently fall back to the
		// worker role).
		const home = useFakeHome()
		seedRoleBlock(home, "worker")

		const validatorFn = await loadValidator()
		await expect(validatorFn(makeState(target))).rejects.toThrow(/validator role not configured/)
	})
})
