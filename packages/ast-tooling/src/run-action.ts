import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
	ENGINE_STATUS,
	type LLMProvider,
	type ModuleManifest,
	type OrchestrationState,
	type StepResponse,
	type ValidationResult,
} from "@repo/protocol"
import { createJiti } from "jiti"
import { loadAction } from "./action-loader.js"
import { materializeTemplates } from "./materialize.js"
import { ModuleRegistry } from "./registry.js"
import { parseActionTemplates } from "./slots.js"
import { runValidators } from "./validator.js"

export interface RunNamedActionInput {
	cwd: string
	module: string
	action: string
	params: Record<string, unknown>
	provider: LLMProvider | null
	model: string
	refill?: boolean
	manualFills?: Record<string, unknown>
	validate?: boolean
}

export interface RunNamedActionResult {
	ok: boolean
	error?: string
	module: string
	action: string
	written: string[]
	skipped: string[]
	slots: Array<{
		id: string
		kind: string
		file: string
		cached: boolean
		source: string
	}>
	tree: Record<string, string>
	output: unknown
	compensationData: unknown
	validation?: ValidationResult
}

function emptyState(cwd: string): OrchestrationState {
	return {
		userIntent: "",
		targetDirectory: cwd,
		status: ENGINE_STATUS.EXECUTING,
		executionPlan: { steps: [], currentStepIndex: 0 },
		logs: [],
		artifacts: {},
	}
}

function loadManifest(moduleRoot: string, moduleName: string): ModuleManifest {
	const manifestPath = join(moduleRoot, "manifest.ts")
	const jiti = createJiti(moduleRoot, { interopDefault: true })
	const mod = jiti(manifestPath) as { Manifest?: ModuleManifest }
	if (!mod.Manifest) throw new Error(`${moduleName}: manifest.ts did not export \`Manifest\``)
	return mod.Manifest
}

export function resolveAction(
	cwd: string,
	moduleName: string,
	actionId: string,
): { moduleRoot: string; manifest: ModuleManifest; action: ModuleManifest["actions"][number] } {
	const registry = new ModuleRegistry(cwd)
	registry.discover(false)
	const moduleRoot = registry.resolveModuleRoot(moduleName)
	if (!moduleRoot) {
		throw new Error(
			`module "${moduleName}" not found (searched tree, project marketplace, user marketplace, and bundled scopes)`,
		)
	}
	const manifest = loadManifest(moduleRoot, moduleName)
	const action = manifest.actions.find((a) => a.id === actionId)
	if (!action) {
		throw new Error(`action "${actionId}" is not declared on module "${moduleName}"`)
	}
	return { moduleRoot, manifest, action }
}

export function listActionSlots(cwd: string, moduleName: string, actionId: string) {
	const { moduleRoot, action } = resolveAction(cwd, moduleName, actionId)
	const templatesDir = join(moduleRoot, action.id, "templates")
	if (!existsSync(templatesDir)) return { module: moduleName, action: actionId, slots: [] }
	const { slots } = parseActionTemplates(templatesDir)
	return { module: moduleName, action: actionId, slots }
}

export function previewAction(cwd: string, moduleName: string, actionId: string) {
	const { moduleRoot, action } = resolveAction(cwd, moduleName, actionId)
	const templatesDir = join(moduleRoot, action.id, "templates")
	const parsed = existsSync(templatesDir) ? parseActionTemplates(templatesDir) : { files: [], slots: [] }
	return {
		module: moduleName,
		action: actionId,
		description: action.description,
		params: action.params,
		requiresReasoning: action.requiresReasoning,
		filePatterns: action.filePatterns,
		files: parsed.files.map((f) => ({ rel: f.rel, source: f.source })),
		slots: parsed.slots,
	}
}

export async function runNamedAction(input: RunNamedActionInput): Promise<RunNamedActionResult> {
	const { cwd, module: moduleName, action: actionId } = input
	try {
		const { moduleRoot, manifest, action } = resolveAction(cwd, moduleName, actionId)
		const templatesDir = join(moduleRoot, action.id, "templates")
		const actionTs = join(moduleRoot, action.id, "action.ts")
		const hasTemplates = existsSync(templatesDir)
		const hasAction = existsSync(actionTs)

		if (!hasTemplates && !hasAction) {
			throw new Error(`action "${actionId}" has neither templates/ nor action.ts`)
		}

		let written: string[] = []
		let skipped: string[] = []
		let slots: RunNamedActionResult["slots"] = []
		let tree: Record<string, string> = {}

		const params = input.params
		if (hasTemplates) {
			const materialized = await materializeTemplates({
				cwd,
				templatesDir,
				params,
				cacheParams: input.params,
				provider: input.provider,
				model: input.model,
				refill: input.refill,
				manualFills: input.manualFills,
			})
			written = materialized.written
			skipped = materialized.skipped
			slots = materialized.slots
			tree = materialized.tree
		}

		let output: unknown = { written, skipped, slots }
		let compensationData: unknown = { written }
		if (hasAction) {
			const loaded = loadAction<Record<string, unknown>, unknown, unknown>(cwd, moduleRoot, manifest, action.id)
			const state = emptyState(cwd)
			const result: StepResponse<unknown, unknown> = await loaded.step.execute(params, state, {
				llmProvider: input.provider,
			})
			if (!result.success) {
				for (const rel of written) {
					try {
						rmSync(join(cwd, rel), { force: true })
					} catch {
						/* best effort */
					}
				}
				return {
					ok: false,
					error: result.error ?? "action failed",
					module: moduleName,
					action: actionId,
					written: [],
					skipped,
					slots,
					tree,
					output: result.output,
					compensationData: result.compensationData,
				}
			}
			output = result.output
			compensationData = result.compensationData
		}

		let validation: ValidationResult | undefined
		if (input.validate !== false) {
			validation = await runValidators(cwd, emptyState(cwd), undefined, moduleName, [moduleName])
		}

		return {
			ok: true,
			module: moduleName,
			action: actionId,
			written,
			skipped,
			slots,
			tree,
			output,
			compensationData,
			validation,
		}
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			module: moduleName,
			action: actionId,
			written: [],
			skipped: [],
			slots: [],
			tree: {},
			output: null,
			compensationData: null,
		}
	}
}
