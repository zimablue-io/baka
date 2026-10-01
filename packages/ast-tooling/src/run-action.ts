import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
	type ActionCompensation,
	type ActionContext,
	type ActionResult,
	type ActionStep,
	BAKA_DEFAULT_WORKER_MODEL,
	type BakaLock,
	type ChangesetEntry,
	ENGINE_STATUS,
	type LLMProvider,
	type ModuleManifest,
	ModuleManifestSchema,
	type ModulePin,
	normalizeParams,
	type OnExisting,
	type OrchestrationState,
	type SlotsInput,
	type StepResponse,
	type ValidationDiagnostic,
} from "@repo/protocol"
import { createJiti } from "jiti"
import { createProjectFiles, type ProjectFiles } from "./action-files.js"
import { loadAction } from "./action-loader.js"
import { removeCreatedDirectories, resolveContained } from "./contain.js"
import { ActionError } from "./errors.js"
import { pinModule, verifyPin } from "./lock.js"
import { applyPlan, planTemplates, type Rollback, revertFiles, type TemplatePlan } from "./materialize.js"
import type { ModuleRegistry } from "./registry.js"
import { createDiskSlotStore, type SlotStore } from "./slot-cache.js"
import { parseActionTemplates } from "./slots.js"
import { compareUtf8, diffSnapshots, outputTreeHash, snapshotDirectories, snapshotTree } from "./tree-hash.js"
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
	/**
	 * What to do with a template target that already exists: `skip` (default),
	 * `overwrite`, or `fail`. Governs template targets and files an `action.ts`
	 * writes through `ctx.files` (it is `ctx.onExisting` there); an action that
	 * writes by other means decides for itself.
	 */
	onExisting?: OnExisting
	/** Slot mode and replay records. Defaults to `{ mode: "live" }`. */
	slots?: SlotsInput
	/**
	 * Compute the changeset and output tree hash against a virtual tree and
	 * write nothing: no files, no slot cache. An action with an `action.ts`
	 * takes part only if its manifest sets `supportsDryRun` (it then writes
	 * through `ctx.files`, which is virtual here); otherwise the run fails
	 * with `dry-run-unsupported`.
	 */
	dryRun?: boolean
	/**
	 * Verify the module against this lock before doing anything else: a
	 * module the lock does not list, or one whose version or files differ,
	 * fails the run with `lock-unlisted` / `lock-mismatch`.
	 */
	lock?: BakaLock
	/** Run the action's and its module's validators after a real run (default true). Dry runs never validate. */
	validate?: boolean
	/** Attach each written file's UTF-8 text to its changeset entry. Off by default: receipts stay small. */
	includeContent?: boolean
}

function buildActionContext(args: {
	root: string
	moduleRoot: string
	manifest: ModuleManifest
	provider: LLMProvider | null
	onExisting: OnExisting
	dryRun: boolean
	files: ProjectFiles
}): ActionContext {
	return {
		llmProvider: args.provider,
		module: { name: args.manifest.name, version: args.manifest.version, root: args.moduleRoot },
		projectRoot: args.root,
		onExisting: args.onExisting,
		dryRun: args.dryRun,
		files: args.files.api,
	}
}

function emptyCompensation(): ActionCompensation {
	return { created: [], createdDirs: [], overwritten: [], actionData: null }
}

/**
 * Run one declared action and return its receipt.
 *
 * Flow: resolve the module and action; plan the templates (slots, render,
 * compare with the disk); write the plan; run `action.ts` if there is one;
 * validate. A failure before or during execution leaves no trace: files the
 * run created are removed and files it overwrote are restored. A validation
 * failure does not roll back; `ok` is false and `compensation` still describes
 * everything written, so the caller decides. Validation covers this action's
 * validators and its module's module-level validators only, and every
 * diagnostic they produce (warnings too) lands in `diagnostics`.
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
	let pins: ModulePin[] = []
	// True once files were written and until the action (if any) succeeded.
	let uncommitted = false
	const diagnostics: ValidationDiagnostic[] = []

	const receipt = (ok: boolean): ActionResult => ({
		ok,
		module: moduleName,
		action: actionId,
		params,
		diagnostics,
		changeset,
		outputTreeHash: outputTreeHash(changeset),
		pins,
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
		const pin = pinModule(moduleRoot, manifest)
		pins = [pin]
		if (input.lock) verifyPin(input.lock, pin)
		const normalized = normalizeParams(action.params, input.params)
		if (!normalized.ok) {
			throw new ActionError("invalid-params", `params for ${moduleName}/${actionId}: ${normalized.message}`)
		}
		params = normalized.params
		if (!hasTemplates && !hasAction) {
			throw new ActionError("action-empty", `action "${actionId}" has neither templates/ nor action.ts`)
		}
		if (dryRun && hasAction && !action.supportsDryRun) {
			throw new ActionError(
				"dry-run-unsupported",
				`action "${actionId}" has an action.ts and does not declare supportsDryRun in its manifest; a dry run cannot virtualise its side effects`,
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
				onExisting: input.onExisting ?? "skip",
			})
		}
		changeset = plan.files.map(({ path, op, contentHash, reason }) => ({
			path,
			op,
			contentHash,
			...(reason ? { reason } : {}),
		}))
		const makeContext = (files: ProjectFiles): ActionContext =>
			buildActionContext({
				root,
				moduleRoot,
				manifest,
				provider,
				onExisting: input.onExisting ?? "skip",
				dryRun,
				files,
			})

		if (dryRun) {
			let read = (path: string): string => plannedContent(plan, path)
			if (hasAction) {
				const projectFiles = createProjectFiles({
					root,
					onExisting: input.onExisting ?? "skip",
					dryRun: true,
					seed: new Map(plan.files.filter((f) => f.op !== "skip").map((f) => [f.path, Buffer.from(f.content)])),
				})
				const loaded = loadAction<Record<string, unknown>, unknown, unknown>(root, moduleRoot, manifest, action.id)
				const run = await executeAction(loaded.step, params, root, makeContext(projectFiles))
				if (run.violations.length > 0) {
					cleanDryRunViolation(root, run)
					throw new ActionError(
						"dry-run-violation",
						`action "${actionId}" changed the project during a dry run instead of writing through ctx.files: ${run.violations.join(", ")}`,
					)
				}
				if (run.failure) throw run.failure
				output = run.result?.output ?? null
				changeset = mergeActionChanges(changeset, [...projectFiles.entries(), ...projectFiles.ownedEntries()])
				read = (path) =>
					plan.files.some((f) => f.path === path) ? plannedContent(plan, path) : projectFiles.api.readText(path)
			}
			if (input.includeContent) changeset = withContent(changeset, read)
			return receipt(true)
		}

		const files = applyPlan(root, plan)
		uncommitted = true
		const written = plan.files.filter((f) => f.op === "create" || f.op === "update").map((f) => f.path)
		compensation = { ...files, actionData: { written } }

		if (hasAction) {
			const projectFiles = createProjectFiles({ root, onExisting: input.onExisting ?? "skip", dryRun: false })
			const loaded = loadAction<Record<string, unknown>, unknown, unknown>(root, moduleRoot, manifest, action.id)
			const ctx = makeContext(projectFiles)
			const run = await executeAction(loaded.step, params, root, ctx)
			// Whatever the outcome, the engine now knows everything the action wrote, so a failure undoes all of it.
			compensation = {
				...mergeRollbacks(files, projectFiles.rollback(), run.created),
				actionData: run.result ? run.result.compensationData : { written },
			}
			if (run.failure) {
				if (run.result) {
					try {
						await loaded.step.compensate(run.result.compensationData, emptyState(root), ctx)
					} catch (err) {
						diagnostics.push({
							severity: "warning",
							rule: "compensate-failed",
							message: `the action's own compensate failed: ${err instanceof Error ? err.message : String(err)}`,
						})
					}
				}
				const unrestorable = run.changes
					.filter((c) => c.op === "update" || c.op === "delete")
					.map((c) => c.path)
					.filter((path) => !compensation.overwritten.some((o) => o.path === path))
				if (unrestorable.length > 0) {
					diagnostics.push({
						severity: "warning",
						rule: "rollback-incomplete",
						message: `files changed outside ctx.files cannot be restored: ${unrestorable.join(", ")}`,
					})
				}
				throw run.failure
			}
			output = run.result?.output ?? null
			changeset = mergeActionChanges(changeset, [
				...run.changes,
				...projectFiles.entries(),
				...projectFiles.ownedEntries(),
			])
		}
		uncommitted = false
		if (input.includeContent) changeset = withContent(changeset, (path) => readFileSync(join(root, path), "utf-8"))

		if (input.validate !== false) {
			const validation = await runValidators(registry, emptyState(root), {
				mode: "actions",
				ran: [
					{
						module: moduleName,
						action: actionId,
						params,
						compensationData: compensation.actionData,
						output,
						changeset,
					},
				],
			})
			diagnostics.push(...validation.diagnostics)
		}
		return receipt(!diagnostics.some((d) => d.severity === "error"))
	} catch (err) {
		const failure =
			err instanceof ActionError ? err : new ActionError("unexpected", err instanceof Error ? err.message : String(err))
		diagnostics.push({ severity: "error", rule: failure.code, message: failure.message })
		if (uncommitted) {
			try {
				revertFiles(root, compensation)
				compensation = emptyCompensation()
				changeset = []
			} catch (rollbackError) {
				// Keep the compensation in the receipt so the caller can retry the undo.
				diagnostics.push({
					severity: "error",
					rule: "unexpected",
					message: `rollback failed, files may remain: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				})
			}
		}
		return receipt(false)
	}
}

/**
 * Attach UTF-8 text to create/update/unchanged entries. `read` supplies the
 * text: the file on disk for a real run, the virtual tree for a dry run.
 */
function withContent(changeset: ChangesetEntry[], read: (path: string) => string): ChangesetEntry[] {
	return changeset.map((entry) => {
		if (entry.op !== "create" && entry.op !== "update" && entry.op !== "unchanged") return entry
		return { ...entry, content: read(entry.path) }
	})
}

function plannedContent(plan: TemplatePlan, path: string): string {
	const file = plan.files.find((f) => f.path === path)
	if (!file) throw new ActionError("unexpected", `no planned content for "${path}"`)
	return file.content
}

/** What running an `action.ts` did, as the engine saw it. */
interface ActionRun {
	result?: StepResponse<unknown, unknown>
	/** Set when `execute` threw or reported `success: false`. */
	failure?: ActionError
	/** create/update/delete entries from hashing the project tree before and after `execute`. */
	changes: ChangesetEntry[]
	/** What undoes the files and directories the action created, whichever way it wrote them. */
	created: Rollback
	/** Every path the tree diff reports, plus the directories created: in a dry run, anything here is a violation. */
	violations: string[]
}

/**
 * Run `execute` with the project tree hashed before and after, so the engine
 * knows what the action did even when it wrote with plain `node:fs`.
 */
async function executeAction(
	step: ActionStep<Record<string, unknown>, unknown, unknown>,
	params: Record<string, unknown>,
	root: string,
	ctx: ActionContext,
): Promise<ActionRun> {
	const filesBefore = snapshotTree(root)
	const dirsBefore = snapshotDirectories(root)
	let result: StepResponse<unknown, unknown> | undefined
	let failure: ActionError | undefined
	try {
		result = await step.execute(params, emptyState(root), ctx)
		if (!result.success) failure = new ActionError("action-failed", result.error ?? "action failed")
	} catch (err) {
		failure =
			err instanceof ActionError
				? err
				: new ActionError("action-failed", err instanceof Error ? err.message : String(err))
	}
	const changes = diffSnapshots(filesBefore, snapshotTree(root))
	const newDirs = [...snapshotDirectories(root)].filter((dir) => !dirsBefore.has(dir))
	return {
		result,
		failure,
		changes,
		created: {
			created: changes.filter((c) => c.op === "create").map((c) => c.path),
			createdDirs: newDirs,
			overwritten: [],
		},
		violations: [...changes.map((c) => c.path), ...newDirs.map((dir) => `${dir}/`)],
	}
}

/** Best-effort cleanup of what an action wrote straight to the disk during a dry run. */
function cleanDryRunViolation(root: string, run: ActionRun): void {
	for (const path of run.created.created) rmSync(resolveContained(root, path), { force: true })
	removeCreatedDirectories(root, run.created.createdDirs)
}

/** One rollback out of several: duplicates dropped, first previous bytes kept, parents before children in `createdDirs`. */
function mergeRollbacks(...parts: Rollback[]): Rollback {
	const created = new Set<string>()
	const dirs = new Set<string>()
	const overwritten = new Map<string, { path: string; contentBase64: string }>()
	for (const part of parts) {
		for (const path of part.created) created.add(path)
		for (const dir of part.createdDirs) dirs.add(dir)
		for (const entry of part.overwritten) if (!overwritten.has(entry.path)) overwritten.set(entry.path, entry)
	}
	const depth = (dir: string) => dir.split("/").length
	return {
		created: [...created],
		createdDirs: [...dirs].sort((a, b) => depth(a) - depth(b) || compareUtf8(a, b)),
		overwritten: [...overwritten.values()],
	}
}

/**
 * Fold what a side-effect action did into the template changeset. Paths the
 * templates already addressed keep their entry (a created file the action
 * then edited is still a create) but take the final content hash; a file the
 * action found unchanged or skipped leaves the template's account alone.
 * Everything else the action addressed is added as it is: that is how an
 * `unchanged` output of a rerun reaches the receipt and keeps its hash.
 */
function mergeActionChanges(planned: ChangesetEntry[], changes: ChangesetEntry[]): ChangesetEntry[] {
	const byPath = new Map(planned.map((e) => [e.path, { ...e }]))
	for (const change of changes) {
		const entry = byPath.get(change.path)
		if (!entry) {
			byPath.set(change.path, change)
		} else if (change.op === "delete") {
			byPath.set(change.path, change)
		} else if (change.op === "create" || change.op === "update") {
			entry.contentHash = change.contentHash
			if (entry.op === "unchanged" || entry.op === "skip") {
				entry.op = "update"
				delete entry.reason
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
	const files = createProjectFiles({ root: registry.root, onExisting: "skip", dryRun: false })
	await loaded.step.compensate(
		compensation.actionData,
		emptyState(registry.root),
		buildActionContext({
			root: registry.root,
			moduleRoot,
			manifest,
			provider: input.provider ?? null,
			onExisting: "skip",
			dryRun: false,
			files,
		}),
	)
}
