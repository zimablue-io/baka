import {
	actionResultJsonSchema,
	ENGINE_STATUS,
	type JsonSchema,
	type ModuleAction,
	type ModuleManifest,
	type OrchestrationState,
	paramsJsonSchema,
	type ValidationDiagnostic,
	type ValidationResult,
} from "@repo/protocol"
import type { ModuleRegistry } from "./registry.js"
import { moduleContentHash } from "./tree-hash.js"
import { runValidators } from "./validator.js"

export interface CatalogAction {
	id: string
	description: string
	params: ModuleAction["params"]
	/** JSON Schema (draft-07) of the params, generated from the same Zod schema `runAction` validates against. */
	paramsSchema: JsonSchema
	requiresReasoning: boolean
	filePatterns: string[]
	compensatesWith?: string
}

export interface CatalogModule {
	name: string
	version: string
	/** The module's content hash (the `contentHash` a lockfile pins); see docs/MODULES.md. */
	contentHash: string
	description: string
	actions: CatalogAction[]
}

export interface Catalog {
	modules: CatalogModule[]
	/** JSON Schema (draft-07) of the receipt `runAction` returns. */
	resultSchema: JsonSchema
	diagnostics: ValidationDiagnostic[]
}

/**
 * The finite action space of a registry: every discovered module with its
 * actions and param declarations, plus the discovery diagnostics.
 */
export function describeModules(registry: ModuleRegistry): Catalog {
	const { modules, diagnostics } = registry.discover(false)
	return {
		modules: modules.map((m) => describeModule(m, registry.moduleRootFor(m.name))),
		resultSchema: actionResultJsonSchema(),
		diagnostics,
	}
}

function describeModule(m: ModuleManifest, moduleRoot: string | undefined): CatalogModule {
	return {
		name: m.name,
		version: m.version,
		contentHash: moduleRoot ? moduleContentHash(moduleRoot) : "",
		description: m.description,
		actions: m.actions.map((a) => ({
			id: a.id,
			description: a.description,
			params: a.params,
			paramsSchema: paramsJsonSchema(a.params),
			requiresReasoning: a.requiresReasoning,
			filePatterns: a.filePatterns,
			compensatesWith: a.compensatesWith,
		})),
	}
}

export interface ValidateResult {
	valid: boolean
	modulesDiscovered: number
	validation: ValidationResult
	moduleName?: string
}

export class ModuleNotFoundError extends Error {
	constructor(readonly moduleName: string) {
		super(`module "${moduleName}" not found`)
		this.name = "ModuleNotFoundError"
	}
}

/**
 * Run every module validator (or one module's) against the registry's
 * project root. Throws `ModuleNotFoundError` when `moduleName` names no
 * discovered module, so callers can map it to their own user-error channel.
 */
export async function validateProject(registry: ModuleRegistry, moduleName?: string): Promise<ValidateResult> {
	const { modules } = registry.discover(false)
	if (moduleName && !modules.some((m) => m.name === moduleName)) {
		throw new ModuleNotFoundError(moduleName)
	}
	const state: OrchestrationState = {
		userIntent: "",
		targetDirectory: registry.root,
		status: ENGINE_STATUS.VALIDATING,
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
	const validation = await runValidators(registry, state, undefined, moduleName)
	return { valid: validation.kind !== "fail", modulesDiscovered: modules.length, validation, moduleName }
}
