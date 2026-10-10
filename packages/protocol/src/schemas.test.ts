// Contract tests for the protocol zod schemas. These schemas are the wire
// contract between the orchestrator, the worker, the CLI, and pack authors
// (via baka-sdk). The tests pin the shapes every consumer relies on:
//   - which fields are required vs defaulted
//   - which values enums accept and reject
//   - that parsed output carries the documented defaults
// A schema change that breaks one of these tests is a breaking protocol
// change for the CLI, the MCP server, and every installed pack.

import { describe, expect, it } from "vitest"
import { ENGINE_STATUS } from "./constants"
import {
	OrchestrationStateSchema,
	PackManifestSchema,
	PackRecipeParamSchema,
	PackRecipeSchema,
	ResolvedPlanSchema,
	ResolvedPlanStepSchema,
	SlotDeclSchema,
	SlotFillSchema,
	SlotKindSchema,
} from "./schemas"
import { AgentRole } from "./types"

describe("PackRecipeParamSchema", () => {
	it("accepts a fully-specified param of every supported type", () => {
		for (const type of ["string", "boolean", "number", "enum"] as const) {
			const parsed = PackRecipeParamSchema.parse({
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
			PackRecipeParamSchema.safeParse({
				name: "name",
				type: "date",
				required: true,
				description: "the name",
			}).success,
		).toBe(false)
	})

	it("rejects an empty param name", () => {
		expect(
			PackRecipeParamSchema.safeParse({ name: "", type: "string", required: false, description: "x" }).success,
		).toBe(false)
	})
})

describe("PackRecipeParamSchema string constraints", () => {
	const base = { name: "p", required: true, description: "d" }

	it("accepts pattern, minLength, maxLength, and a named format on a string", () => {
		const parsed = PackRecipeParamSchema.safeParse({
			...base,
			type: "string",
			pattern: "^a",
			minLength: 1,
			maxLength: 9,
			format: "slug",
		})
		expect(parsed.success).toBe(true)
	})

	it("rejects them on any other type", () => {
		for (const extra of [{ pattern: "a" }, { minLength: 1 }, { maxLength: 1 }, { format: "slug" }]) {
			expect(PackRecipeParamSchema.safeParse({ ...base, type: "number", ...extra }).success).toBe(false)
		}
	})

	it("rejects an invalid regular expression, an unknown format, and min greater than max", () => {
		expect(PackRecipeParamSchema.safeParse({ ...base, type: "string", pattern: "(" }).success).toBe(false)
		expect(PackRecipeParamSchema.safeParse({ ...base, type: "string", format: "email" }).success).toBe(false)
		expect(PackRecipeParamSchema.safeParse({ ...base, type: "string", minLength: 3, maxLength: 2 }).success).toBe(false)
	})

	it("rejects a default that violates the constraints", () => {
		const parsed = PackRecipeParamSchema.safeParse({
			...base,
			required: false,
			type: "string",
			format: "slug",
			default: "Not A Slug",
		})
		expect(parsed.success).toBe(false)
	})
})

describe("PackRecipeSchema", () => {
	it("applies the documented defaults for requiresReasoning, filePatterns, and validators", () => {
		const parsed = PackRecipeSchema.parse({ id: "scaffold", description: "scaffold a project", params: [] })
		expect(parsed.requiresReasoning).toBe(false)
		expect(parsed.filePatterns).toEqual([])
		expect(parsed.validators).toEqual([])
	})

	it("preserves explicit reasoning and compensation declarations", () => {
		const parsed = PackRecipeSchema.parse({
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

	it("accepts an explicit `toolchain: 'tsc'` declaration (screening layer 3)", () => {
		const parsed = PackRecipeSchema.parse({
			id: "scaffold",
			description: "scaffold a TS project",
			params: [],
			filePatterns: ["src/index.ts"],
			toolchain: "tsc",
		})
		expect(parsed.toolchain).toBe("tsc")
	})

	it("rejects a toolchain value outside the declared closed set", () => {
		expect(
			PackRecipeSchema.safeParse({
				id: "x",
				description: "x",
				params: [],
				toolchain: "eslint",
			}).success,
		).toBe(false)
		expect(
			PackRecipeSchema.safeParse({
				id: "x",
				description: "x",
				params: [],
				toolchain: "tsc --noEmit",
			}).success,
		).toBe(false)
	})
})

describe("PackManifestSchema", () => {
	const validRecipe = { id: "scaffold", description: "scaffold a project", params: [] }

	it("accepts a minimal manifest and applies defaults", () => {
		const parsed = PackManifestSchema.parse({ name: "acme-mod", version: "0.1.0", recipes: [validRecipe] })
		expect(parsed.description).toBe("")
		expect(parsed.dependencies).toEqual([])
		expect(parsed.conflictsWith).toEqual([])
		expect(parsed.packValidators).toEqual([])
	})

	it("rejects a manifest with zero recipes (a pack must do something)", () => {
		expect(PackManifestSchema.safeParse({ name: "empty", version: "0.1.0", recipes: [] }).success).toBe(false)
	})

	it("rejects a manifest missing name or version", () => {
		expect(PackManifestSchema.safeParse({ version: "0.1.0", recipes: [validRecipe] }).success).toBe(false)
		expect(PackManifestSchema.safeParse({ name: "x", recipes: [validRecipe] }).success).toBe(false)
	})
})

describe("ResolvedPlanStepSchema", () => {
	it("accepts arbitrary JSON params (pack-defined, not protocol-enforced)", () => {
		const parsed = ResolvedPlanStepSchema.parse({
			id: "step-1",
			pack: "acme-mod",
			recipe: "scaffold",
			params: { name: "app", packType: "esm", nested: { deep: [1, 2] } },
		})
		expect(parsed.params).toEqual({ name: "app", packType: "esm", nested: { deep: [1, 2] } })
	})

	it("rejects a step missing the pack/recipe pair the worker resolves against", () => {
		expect(ResolvedPlanStepSchema.safeParse({ id: "step-1", recipe: "scaffold", params: {} }).success).toBe(false)
		expect(ResolvedPlanStepSchema.safeParse({ id: "step-1", pack: "acme-mod", params: {} }).success).toBe(false)
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

describe("SlotKindSchema / SlotDeclSchema / SlotFillSchema", () => {
	it("accepts the four slot kinds and rejects others", () => {
		for (const kind of ["prose", "ident", "list", "json"] as const) {
			expect(SlotKindSchema.parse(kind)).toBe(kind)
		}
		expect(SlotKindSchema.safeParse("essay").success).toBe(false)
	})

	it("requires a slot id, kind, hint, and file", () => {
		const parsed = SlotDeclSchema.parse({
			id: "introduction",
			kind: "prose",
			hint: "2-3 sentences",
			file: "README.md.hbs",
			max: 120,
		})
		expect(parsed.id).toBe("introduction")
		expect(parsed.max).toBe(120)
	})

	it("accepts a fill value as string, list, or object", () => {
		expect(SlotFillSchema.parse({ value: "A tiny CLI." }).value).toBe("A tiny CLI.")
		expect(SlotFillSchema.parse({ value: ["a", "b"] }).value).toEqual(["a", "b"])
		expect(SlotFillSchema.parse({ value: { k: "v" } }).value).toEqual({ k: "v" })
	})
})
