import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	type ActionCompensation,
	type ActionResult,
	BAKA_DEFAULT_WORKER_MODEL,
	type ChangesetEntry,
	ENGINE_STATUS,
	type LLMProvider,
	type ModuleManifest,
	ModuleManifestSchema,
	normalizeParams,
	type OrchestrationState,
	type SlotsInput,
	type StepResponse,
	type ValidationDiagnostic,
} from "@repo/protocol"
import { createJiti } from "jiti"
import { loadAction } from "./action-loader.js"
import { ActionError } from "./errors.js"
import { applyPlan, planTemplates, revertFiles, type TemplatePlan } from "./materialize.js"
import type { ModuleRegistry } from "./registry.js"
import { createDiskSlotStore, type SlotStore } from "./slot-cache.js"
import { parseActionTemplates } from "./slots.js"
import { compareUtf8, diffSnapshots, outputTreeHash, snapshotTree } from "./tree-hash.js"
import { runValidators } from "./validator.js"

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
	if (!mod.Manifest) {
		throw new ActionError("module-invalid", `${moduleName}: manifest.ts did not export \`Manifest\``)
	}
	const parsed = ModuleManifestSchema.safeParse(mod.Manifest)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
		throw new ActionError("module-invalid", `${moduleName}: manifest does not match the schema: ${issues}`)
	}
	return parsed.data
}

export function resolveAction(
	registry: ModuleRegistry,
	moduleName: string,
	actionId: string,
): { moduleRoot: string; manifest: ModuleManifest; action: ModuleManifest["actions"][number] } {
	const moduleRoot = registry.resolveModuleRoot(moduleName)
	if (!moduleRoot) {
		throw new ActionError("module-not-found", `module "${moduleName}" not found in the registry's module directories`)
	}
	const manifest = loadManifest(moduleRoot, moduleName)
	const action = manifest.actions.find((a) => a.id === actionId)
	if (!action) {
		throw new ActionError("action-not-found", `action "${actionId}" is not declared on module "${moduleName}"`)
	}
	return { moduleRoot, manifest, action }
}

export function listActionSlots(registry: ModuleRegistry, moduleName: string, actionId: string) {
	const { moduleRoot, action } = resolveAction(registry, moduleName, actionId)
	const templatesDir = join(moduleRoot, action.id, "templates")
	if (!existsSync(templatesDir)) return { module: moduleName, action: actionId, slots: [] }
	const { slots } = parseActionTemplates(templatesDir)
	return { module: moduleName, action: actionId, slots }
}

export function previewAction(registry: ModuleRegistry, moduleName: string, actionId: string) {
	const { moduleRoot, action } = resolveAction(registry, moduleName, actionId)
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

export interface RunActionInput {
	/** Where modules come from; `registry.root` is the directory the action writes into. */
	registry: ModuleRegistry
	module: string
	action: string
	params: Record<string, unknown>
	/** The injected model. Null or omitted means no model call may be made. */
	provider?: LLMProvider | null
	/** Model id sent to the provider and mixed into the slot cache key. */
	model?: string
	/** Slot cache. Defaults to the project's on-disk cache, without the user-level fallback. */
	store?: SlotStore
	/** Slot mode and replay records. Defaults to `{ mode: "live" }`. */
	slots?: SlotsInput
	/**
	 * Compute the changeset and output tree hash against a virtual tree and
	 * write nothing: no files, no slot cache. Template-only actions only; an
	 * action with `action.ts` has side effects that cannot be virtualised and
	 * fails with `dry-run-unsupported`.
	 */
	dryRun?: boolean
	/** Run the module's validators after a real run (default true). Dry runs never validate. */
	validate?: boolean
	/** Attach each written file's UTF-8 text to its changeset entry. Off by default: receipts stay small. */
	includeContent?: boolean
}

function emptyCompensation(): ActionCompensation {
	return { created: [], overwritten: [], actionData: null }
}

/**
 * Run one declared action and return its receipt.
 *
 * Flow: resolve the module and action; plan the templates (slots, render,
 * compare with the disk); write the plan; run `action.ts` if there is one;
 * validate. A failure before or during execution leaves no trace: files the
 * run created are removed and files it overwrote are restored. A validation
 * failure does not roll back; `ok` is false and `compensation` still describes
 * everything written, so the caller decides.
 */
export async function runAction(input: RunActionInput): Promise<ActionResult> {
	const { registry, module: moduleName, action: actionId } = input
	const root = registry.root
	const dryRun = input.dryRun === true
	const provider = input.provider ?? null
	const model = input.model ?? BAKA_DEFAULT_WORKER_MODEL
	let params = input.params

	let plan: TemplatePlan = { files: [], slots: [] }
	let compensation = emptyCompensation()
	let changeset: ChangesetEntry[] = []
	let output: unknown = null
	// True once files were written and until the action (if any) succeeded.
	let uncommitted = false
	const diagnostics: ValidationDiagnostic[] = []

	const receipt = (ok: boolean): ActionResult => ({
		ok,
		module: moduleName,
		action: actionId,
		diagnostics,
		changeset,
		outputTreeHash: outputTreeHash(changeset),
		slots: plan.slots,
		compensation,
		output,
		dryRun,
	})

	try {
		const { moduleRoot, manifest, action } = resolveAction(registry, moduleName, actionId)
		const templatesDir = join(moduleRoot, action.id, "templates")
		const hasTemplates = existsSync(templatesDir)
		const hasAction = existsSync(join(moduleRoot, action.id, "action.ts"))
		const normalized = normalizeParams(action.params, input.params)
		if (!normalized.ok) {
			throw new ActionError("invalid-params", `params for ${moduleName}/${actionId}: ${normalized.message}`)
		}
		params = normalized.params
		if (!hasTemplates && !hasAction) {
			throw new ActionError("action-empty", `action "${actionId}" has neither templates/ nor action.ts`)
		}
		if (dryRun && hasAction) {
			throw new ActionError(
				"dry-run-unsupported",
				`action "${actionId}" has an action.ts with side effects; a dry run can only compute template-only actions`,
			)
		}

		if (hasTemplates) {
			plan = await planTemplates({
				root,
				templatesDir,
				params,
				provider,
				model,
				store: input.store ?? createDiskSlotStore(root),
				persist: !dryRun,
				slotMode: input.slots?.mode ?? "live",
				records: input.slots?.records ?? [],
			})
		}
		changeset = plan.files.map(({ path, op, contentHash, reason }) => ({
			path,
			op,
			contentHash,
			...(reason ? { reason } : {}),
		}))
		if (dryRun) {
			if (input.includeContent) changeset = withContent(root, changeset, plan)
			return receipt(true)
		}

		const files = applyPlan(root, plan)
		uncommitted = true
		const written = plan.files.filter((f) => f.op === "create" || f.op === "update").map((f) => f.path)
		compensation = { ...files, actionData: { written } }

		if (hasAction) {
			const loaded = loadAction<Record<string, unknown>, unknown, unknown>(root, moduleRoot, manifest, action.id)
			const before = snapshotTree(root)
			let result: StepResponse<unknown, unknown>
			try {
				result = await loaded.step.execute(params, emptyState(root), { llmProvider: provider })
			} catch (err) {
				throw new ActionError("action-failed", err instanceof Error ? err.message : String(err))
			}
			output = result.output
			if (!result.success) throw new ActionError("action-failed", result.error ?? "action failed")
			compensation = { ...compensation, actionData: result.compensationData }
			changeset = mergeActionChanges(changeset, diffSnapshots(before, snapshotTree(root)))
		}
		uncommitted = false
		if (input.includeContent) changeset = withContent(root, changeset, null)

		if (input.validate !== false) {
			const validation = await runValidators(registry, emptyState(root), undefined, moduleName, [moduleName])
			if (validation.kind === "fail") diagnostics.push(...validation.diagnostics)
		}
		return receipt(!diagnostics.some((d) => d.severity === "error"))
	} catch (err) {
		const failure =
			err instanceof ActionError ? err : new ActionError("unexpected", err instanceof Error ? err.message : String(err))
		if (uncommitted) {
			revertFiles(root, compensation)
			compensation = emptyCompensation()
			changeset = []
		}
		diagnostics.push({ severity: "error", rule: failure.code, message: failure.message })
		return receipt(false)
	}
}

/**
 * Attach UTF-8 text to create/update/unchanged entries. A dry run has nothing
 * on disk yet, so it reads the rendered text from the plan; a real run reads
 * the file, which also covers anything a side-effect action changed after.
 */
function withContent(root: string, changeset: ChangesetEntry[], plan: TemplatePlan | null): ChangesetEntry[] {
	const rendered = new Map((plan?.files ?? []).map((f) => [f.path, f.content]))
	return changeset.map((entry) => {
		if (entry.op !== "create" && entry.op !== "update" && entry.op !== "unchanged") return entry
		const content = rendered.get(entry.path) ?? readFileSync(join(root, entry.path), "utf-8")
		return { ...entry, content }
	})
}

/**
 * Fold the files a side-effect action touched into the template changeset.
 * Paths the templates already addressed keep their entry (a created file the
 * action then edited is still a create) but take the final content hash.
 */
function mergeActionChanges(planned: ChangesetEntry[], changes: ChangesetEntry[]): ChangesetEntry[] {
	const byPath = new Map(planned.map((e) => [e.path, { ...e }]))
	for (const change of changes) {
		const entry = byPath.get(change.path)
		if (!entry) {
			byPath.set(change.path, change)
		} else if (change.op === "delete") {
			byPath.set(change.path, change)
		} else {
			entry.contentHash = change.contentHash
			if (entry.op === "unchanged" || entry.op === "skip") {
				entry.op = "update"
				entry.reason = undefined
			}
		}
	}
	return [...byPath.values()].sort((a, b) => compareUtf8(a.path, b.path))
}

export interface CompensateActionInput {
	registry: ModuleRegistry
	module: string
	action: string
	compensation: ActionCompensation
	provider?: LLMProvider | null
}

/**
 * Undo a run from its receipt: delete what it created, restore what it
 * overwrote, then hand the action's own compensation data back to its
 * `compensate` (side-effect actions only).
 */
export async function compensateAction(input: CompensateActionInput): Promise<void> {
	const { registry, compensation } = input
	revertFiles(registry.root, compensation)
	if (compensation.actionData == null) return
	const { moduleRoot, manifest, action } = resolveAction(registry, input.module, input.action)
	if (!existsSync(join(moduleRoot, action.id, "action.ts"))) return
	const loaded = loadAction<unknown, unknown, unknown>(registry.root, moduleRoot, manifest, action.id)
	await loaded.step.compensate(compensation.actionData, emptyState(registry.root), {
		llmProvider: input.provider ?? null,
	})
}
