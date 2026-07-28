// Contract tests for the protocol zod schemas. These schemas are the wire
// contract between the orchestrator, the worker, the CLI, and module authors
// (via baka-sdk). The tests pin the shapes every consumer relies on:
//   - which fields are required vs defaulted
//   - which values enums accept and reject
//   - that parsed output carries the documented defaults
// A schema change that breaks one of these tests is a breaking protocol
// change for the CLI, the MCP server, and every installed module.

import { describe, expect, it } from "vitest"
import { ENGINE_STATUS } from "./constants"
import {
	ModuleActionParamSchema,
	ModuleActionSchema,
	ModuleManifestSchema,
	OrchestrationStateSchema,
	ResolvedPlanSchema,
	ResolvedPlanStepSchema,
} from "./schemas"
import { AgentRole } from "./types"

describe("ModuleActionParamSchema", () => {
	it("accepts a fully-specified param of every supported type", () => {
		for (const type of ["string", "boolean", "number", "enum"] as const) {
			const parsed = ModuleActionParamSchema.parse({
				name: "name",
				type,
				required: true,
				description: "the name",
				enumValues: type === "enum" ? ["a", "b"] : undefined,
			})
			expect(parsed.type).toBe(type)
		}
	})

	it("rejects a param type outside the supported set", () => {
		expect(
			ModuleActionParamSchema.safeParse({
				name: "name",
				type: "date",
				required: true,
				description: "the name",
			}).success,
		).toBe(false)
	})

	it("rejects an empty param name", () => {
		expect(
			ModuleActionParamSchema.safeParse({ name: "", type: "string", required: false, description: "x" }).success,
		).toBe(false)
	})
})

describe("ModuleActionSchema", () => {
	it("applies the documented defaults for requiresReasoning, filePatterns, and validators", () => {
		const parsed = ModuleActionSchema.parse({ id: "scaffold", description: "scaffold a project", params: [] })
		expect(parsed.requiresReasoning).toBe(false)
		expect(parsed.filePatterns).toEqual([])
		expect(parsed.validators).toEqual([])
	})

	it("preserves explicit reasoning and compensation declarations", () => {
		const parsed = ModuleActionSchema.parse({
			id: "init-constitution",
			description: "generate a constitution",
			params: [],
			requiresReasoning: true,
			compensatesWith: "remove-constitution",
			filePatterns: ["specs/*.md"],
			validators: ["constitution-coherent"],
		})
		expect(parsed.requiresReasoning).toBe(true)
		expect(parsed.compensatesWith).toBe("remove-constitution")
		expect(parsed.filePatterns).toEqual(["specs/*.md"])
		expect(parsed.validators).toEqual(["constitution-coherent"])
	})
})

describe("ModuleManifestSchema", () => {
	const validAction = { id: "scaffold", description: "scaffold a project", params: [] }

	it("accepts a minimal manifest and applies defaults", () => {
		const parsed = ModuleManifestSchema.parse({ name: "baka-base", version: "0.1.0", actions: [validAction] })
		expect(parsed.description).toBe("")
		expect(parsed.dependencies).toEqual([])
		expect(parsed.conflictsWith).toEqual([])
		expect(parsed.moduleValidators).toEqual([])
	})

	it("rejects a manifest with zero actions (a module must do something)", () => {
		expect(ModuleManifestSchema.safeParse({ name: "empty", version: "0.1.0", actions: [] }).success).toBe(false)
	})

	it("rejects a manifest missing name or version", () => {
		expect(ModuleManifestSchema.safeParse({ version: "0.1.0", actions: [validAction] }).success).toBe(false)
		expect(ModuleManifestSchema.safeParse({ name: "x", actions: [validAction] }).success).toBe(false)
	})
})

describe("ResolvedPlanStepSchema", () => {
	it("accepts arbitrary JSON params (module-defined, not protocol-enforced)", () => {
		const parsed = ResolvedPlanStepSchema.parse({
			id: "step-1",
			module: "baka-base",
			action: "scaffold",
			params: { name: "app", moduleType: "esm", nested: { deep: [1, 2] } },
		})
		expect(parsed.params).toEqual({ name: "app", moduleType: "esm", nested: { deep: [1, 2] } })
	})

	it("rejects a step missing the module/action pair the worker resolves against", () => {
		expect(ResolvedPlanStepSchema.safeParse({ id: "step-1", action: "scaffold", params: {} }).success).toBe(false)
		expect(ResolvedPlanStepSchema.safeParse({ id: "step-1", module: "baka-base", params: {} }).success).toBe(false)
	})
})

describe("ResolvedPlanSchema", () => {
	it("accepts an empty plan (the honest empty-catalog case carries zero steps)", () => {
		expect(ResolvedPlanSchema.parse({ resolvedSteps: [] }).resolvedSteps).toEqual([])
	})

	it("rejects a plan whose steps are malformed", () => {
		expect(ResolvedPlanSchema.safeParse({ resolvedSteps: [{ id: "step-1" }] }).success).toBe(false)
	})
})

describe("OrchestrationStateSchema", () => {
	const baseState = {
		userIntent: "build an app",
		targetDirectory: "/tmp/app",
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
	}

	it("accepts every ENGINE_STATUS value as a valid status", () => {
		for (const status of Object.values(ENGINE_STATUS)) {
			expect(OrchestrationStateSchema.safeParse({ ...baseState, status }).success, `status ${status}`).toBe(true)
		}
	})

	it("rejects a status outside the engine state machine", () => {
		expect(OrchestrationStateSchema.safeParse({ ...baseState, status: "HUNG" }).success).toBe(false)
	})

	it("defaults artifacts to an empty record and accepts an optional currentRole", () => {
		const parsed = OrchestrationStateSchema.parse({ ...baseState, status: ENGINE_STATUS.EXECUTING })
		expect(parsed.artifacts).toEqual({})
		expect(parsed.currentRole).toBeUndefined()

		const withRole = OrchestrationStateSchema.parse({
			...baseState,
			status: ENGINE_STATUS.VALIDATING,
			currentRole: AgentRole.VALIDATOR,
		})
		expect(withRole.currentRole).toBe(AgentRole.VALIDATOR)
	})

	it("rejects a currentRole outside the AgentRole enum", () => {
		expect(OrchestrationStateSchema.safeParse({ ...baseState, status: "IDLE", currentRole: "plumber" }).success).toBe(
			false,
		)
	})
})
