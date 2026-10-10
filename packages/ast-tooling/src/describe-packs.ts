import {
	ENGINE_STATUS,
	type JsonSchema,
	type OrchestrationState,
	type PackManifest,
	type PackRecipe,
	paramsJsonSchema,
	recipeResultJsonSchema,
	type ValidationDiagnostic,
	type ValidationResult,
} from "@repo/protocol"
import type { PackRegistry } from "./registry.js"
import { packContentHash } from "./tree-hash.js"
import { runValidators } from "./validator.js"

export interface CatalogRecipe {
	id: string
	description: string
	params: PackRecipe["params"]
	/** JSON Schema (draft-07) of the params, generated from the same Zod schema `runRecipe` validates against. */
	paramsSchema: JsonSchema
	requiresReasoning: boolean
	filePatterns: string[]
	compensatesWith?: string
	/** The formatter the recipe declares, for a caller that runs it itself (or asks `runRecipe` to with `format: true`). */
	format?: { command: string; args: string[] }
}

export interface CatalogPack {
	name: string
	version: string
	/** The pack's content hash (the `contentHash` a lockfile pins); see docs/PACKS.md. */
	contentHash: string
	description: string
	recipes: CatalogRecipe[]
}

export interface Catalog {
	schema: "baka.catalog/1"
	packs: CatalogPack[]
	/** JSON Schema (draft-07) of the receipt `runRecipe` returns. */
	resultSchema: JsonSchema
	diagnostics: ValidationDiagnostic[]
}

/**
 * The finite set of recipes of a registry: every discovered pack with its
 * recipes and param declarations, plus the discovery diagnostics.
 */
export function describePacks(registry: PackRegistry): Catalog {
	const { packs, diagnostics } = registry.discover(false)
	return {
		schema: "baka.catalog/1",
		packs: packs.map((m) => describePack(m, registry.packRootFor(m.name))),
		resultSchema: recipeResultJsonSchema(),
		diagnostics,
	}
}

function describePack(m: PackManifest, packRoot: string | undefined): CatalogPack {
	return {
		name: m.name,
		version: m.version,
		contentHash: packRoot ? packContentHash(packRoot) : "",
		description: m.description,
		recipes: m.recipes.map((a) => ({
			id: a.id,
			description: a.description,
			params: a.params,
			paramsSchema: paramsJsonSchema(a.params),
			requiresReasoning: a.requiresReasoning,
			filePatterns: a.filePatterns,
			compensatesWith: a.compensatesWith,
			...(a.format ? { format: a.format } : {}),
		})),
	}
}

export interface ValidateResult {
	valid: boolean
	packsDiscovered: number
	validation: ValidationResult
	packName?: string
}

export class PackNotFoundError extends Error {
	constructor(readonly packName: string) {
		super(`pack "${packName}" not found`)
		this.name = "PackNotFoundError"
	}
}

/**
 * Run every pack validator (or one pack's) against the registry's
 * project root. Throws `PackNotFoundError` when `packName` names no
 * discovered pack, so callers can map it to their own user-error channel.
 */
export async function validateProject(registry: PackRegistry, packName?: string): Promise<ValidateResult> {
	const { packs } = registry.discover(false)
	if (packName && !packs.some((m) => m.name === packName)) {
		throw new PackNotFoundError(packName)
	}
	const state: OrchestrationState = {
		userIntent: "",
		targetDirectory: registry.root,
		status: ENGINE_STATUS.VALIDATING,
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
	const validation = await runValidators(registry, state, { mode: "project", pack: packName })
	return { valid: validation.kind !== "fail", packsDiscovered: packs.length, validation, packName }
}
