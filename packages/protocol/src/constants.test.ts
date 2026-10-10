// Contract tests for the protocol constants. These values are part of the
// public surface: the CLI maps engine outcomes onto BAKA_EXIT_CODE, docs and
// error messages reference PACK_CATEGORY, and the engine state machine is
// ENGINE_STATUS. The tests pin the documented values so a silent renumber
// or rename is caught here, not by a user reading an exit code.

import { describe, expect, it } from "vitest"
import {
	BAKA_DEFAULT_WORKER_MODEL,
	BAKA_EXIT_CODE,
	BAKA_PROJECT_PATHS,
	BAKA_USER_DIR,
	ENGINE_STATUS,
	exitCodeForRule,
	PACK_CATEGORY,
} from "./constants"

describe("BAKA_EXIT_CODE", () => {
	it("carries the documented exit codes the CLI contract promises", () => {
		expect(BAKA_EXIT_CODE.SUCCESS).toBe(0)
		expect(BAKA_EXIT_CODE.FAILED).toBe(1)
		expect(BAKA_EXIT_CODE.BAD_INPUT).toBe(2)
		expect(BAKA_EXIT_CODE.UNAVAILABLE).toBe(3)
	})

	it("assigns each outcome a distinct code (no aliasing between failure modes)", () => {
		const codes = Object.values(BAKA_EXIT_CODE)
		expect(new Set(codes).size).toBe(codes.length)
	})
})

describe("exitCodeForRule", () => {
	it("maps a wrongly named pack, recipe, parameter or slot to bad input", () => {
		for (const rule of ["pack-not-found", "recipe-not-found", "recipe-ambiguous", "invalid-params", "slot-unknown"]) {
			expect(exitCodeForRule(rule), rule).toBe(BAKA_EXIT_CODE.BAD_INPUT)
		}
	})

	it("maps an unreachable model to unavailable", () => {
		expect(exitCodeForRule("slot-provider-error")).toBe(BAKA_EXIT_CODE.UNAVAILABLE)
	})

	it("maps open slots and every other failure to failed", () => {
		for (const rule of ["slots-open", "lock-mismatch", "target-exists", "recipe-failed", undefined]) {
			expect(exitCodeForRule(rule), String(rule)).toBe(BAKA_EXIT_CODE.FAILED)
		}
	})
})

describe("ENGINE_STATUS", () => {
	it("exposes the full state machine the orchestrator can be in", () => {
		expect(Object.values(ENGINE_STATUS).sort()).toEqual(
			["COMPENSATING", "EXECUTING", "FAILED", "IDLE", "PLANNING", "SUCCESS", "VALIDATING"].sort(),
		)
	})
})

describe("path constants", () => {
	it("scopes all per-project state under .baka", () => {
		expect(BAKA_PROJECT_PATHS.ROOT).toBe(".baka")
		for (const [key, path] of Object.entries(BAKA_PROJECT_PATHS)) {
			if (key === "ROOT") continue
			expect(path.startsWith(".baka/"), `${key} must live under .baka/`).toBe(true)
		}
	})

	it("pins the slot cache directory and the one worker-model id", () => {
		expect(BAKA_PROJECT_PATHS.SLOTS).toBe(".baka/slots")
		expect(BAKA_DEFAULT_WORKER_MODEL).toBe("gemma4:e4b")
	})

	it("names the user-level config directory (joined as .baka under the home dir)", () => {
		expect(BAKA_USER_DIR).toBe("baka")
	})
})

describe("PACK_CATEGORY", () => {
	it("reserves the documented category vocabulary", () => {
		expect(Object.values(PACK_CATEGORY).sort()).toEqual(["auth", "base", "data", "framework", "pattern", "ui"].sort())
	})
})
