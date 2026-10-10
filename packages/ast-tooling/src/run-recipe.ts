import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
	BAKA_DEFAULT_WORKER_MODEL,
	type BakaLock,
	type ChangesetEntry,
	ENGINE_STATUS,
	type LLMProvider,
	normalizeParams,
	type OnExisting,
	type OrchestrationState,
	type PackManifest,
	PackManifestSchema,
	type PackPin,
	type RecipeCompensation,
	type RecipeContext,
	type RecipeResult,
	type RecipeStep,
	type SlotsInput,
	type StepResponse,
	type ValidationDiagnostic,
} from "@repo/protocol"
import { createJiti } from "jiti"
import { removeCreatedDirectories, resolveContained } from "./contain.js"
import { RecipeError } from "./errors.js"
import { runFormatter } from "./format.js"
import { pinPack, verifyPin } from "./lock.js"
import { applyPlan, planTemplates, type Rollback, revertFiles, type TemplatePlan } from "./materialize.js"
import { loadPackData } from "./pack-data.js"
import { createProjectFiles, type ProjectFiles } from "./recipe-files.js"
import { loadRecipe } from "./recipe-loader.js"
import type { PackRegistry } from "./registry.js"
import { createDiskSlotStore, type SlotStore } from "./slot-cache.js"
import { hashBytes, parseRecipeTemplates, slotTemplateKey } from "./slots.js"
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

function loadManifest(packRoot: string, packName: string): PackManifest {
	const manifestPath = join(packRoot, "manifest.ts")
	const jiti = createJiti(packRoot, { interopDefault: true })
	const mod = jiti(manifestPath) as { Manifest?: PackManifest }
	if (!mod.Manifest) {
		throw new RecipeError("pack-invalid", `${packName}: manifest.ts did not export \`Manifest\``)
	}
	const parsed = PackManifestSchema.safeParse(mod.Manifest)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
		throw new RecipeError("pack-invalid", `${packName}: manifest does not match the schema: ${issues}`)
	}
	return parsed.data
}

export function resolveRecipe(
	registry: PackRegistry,
	packName: string,
	recipeId: string,
): { packRoot: string; manifest: PackManifest; recipe: PackManifest["recipes"][number] } {
	const packRoot = registry.resolvePackRoot(packName)
	if (!packRoot) {
		throw new RecipeError("pack-not-found", `pack "${packName}" not found in the registry's pack directories`)
	}
	const manifest = loadManifest(packRoot, packName)
	const recipe = manifest.recipes.find((a) => a.id === recipeId)
	if (!recipe) {
		throw new RecipeError("recipe-not-found", `recipe "${recipeId}" is not declared on pack "${packName}"`)
	}
	return { packRoot, manifest, recipe }
}

/**
 * The slots of a recipe's templates, each with its `templateKey`: the `key` a
 * `match: "template"` slot record for it must carry (see `slotTemplateKey`).
 */
function declaredSlots(parsed: ReturnType<typeof parseRecipeTemplates>) {
	return parsed.slots.map((slot) => {
		const file = parsed.files.find((f) => f.rel === slot.file)
		return { ...slot, templateKey: slotTemplateKey({ templateHash: hashBytes(file?.source ?? ""), slotId: slot.id }) }
	})
}

export function listRecipeSlots(registry: PackRegistry, packName: string, recipeId: string) {
	const { packRoot, recipe } = resolveRecipe(registry, packName, recipeId)
	const templatesDir = join(packRoot, recipe.id, "templates")
	if (!existsSync(templatesDir)) return { pack: packName, recipe: recipeId, slots: [] }
	return { pack: packName, recipe: recipeId, slots: declaredSlots(parseRecipeTemplates(templatesDir)) }
}

export function previewRecipe(registry: PackRegistry, packName: string, recipeId: string) {
	const { packRoot, recipe } = resolveRecipe(registry, packName, recipeId)
	const templatesDir = join(packRoot, recipe.id, "templates")
	const parsed = existsSync(templatesDir) ? parseRecipeTemplates(templatesDir) : { files: [], slots: [] }
	return {
		pack: packName,
		recipe: recipeId,
		description: recipe.description,
		params: recipe.params,
		requiresReasoning: recipe.requiresReasoning,
		filePatterns: recipe.filePatterns,
		files: parsed.files.map((f) => ({
			rel: f.rel,
			source: f.source,
			...(f.directive.when ? { when: f.directive.when } : {}),
			...(f.directive.mode ? { mode: f.directive.mode } : {}),
		})),
		slots: declaredSlots(parsed),
	}
}

export interface RunRecipeInput {
	/** Where packs come from; `registry.root` is the directory the recipe writes into. */
	registry: PackRegistry
	pack: string
	recipe: string
	params: Record<string, unknown>
	/** The injected model. Null or omitted means no model call may be made. */
	provider?: LLMProvider | null
	/** Model id sent to the provider and mixed into the slot cache key. */
	model?: string
	/** Slot cache. Defaults to the project's on-disk cache, without the user-level fallback. */
	store?: SlotStore
	/**
	 * What to do with a template target that already exists: `skip` (default),
	 * `overwrite`, or `fail`. Governs template targets and files a `recipe.ts`
	 * writes through `ctx.files` (it is `ctx.onExisting` there); a recipe that
	 * writes by other means decides for itself.
	 */
	onExisting?: OnExisting
	/** Slot mode and replay records. Defaults to `{ mode: "live" }`. */
	slots?: SlotsInput
	/**
	 * Compute the changeset and output tree hash against a virtual tree and
	 * write nothing: no files, no slot cache. A recipe with a `recipe.ts`
	 * takes part only if its manifest sets `supportsDryRun` (it then writes
	 * through `ctx.files`, which is virtual here); otherwise the run fails
	 * with `dry-run-unsupported`.
	 */
	dryRun?: boolean
	/**
	 * Verify the pack against this lock before doing anything else: a
	 * pack the lock does not list, or one whose version or files differ,
	 * fails the run with `lock-unlisted` / `lock-mismatch`.
	 */
	lock?: BakaLock
	/**
	 * Run the formatter the recipe declares (`format` in its manifest) over the
	 * files this run created or updated, before validation. The receipt then
	 * holds the formatted bytes' hashes. Off by default: Baka never runs a
	 * pack's command unasked. Not available in a dry run (`dry-run-unsupported`).
	 */
	format?: boolean
	/** Run the recipe's and its pack's validators after a real run (default true). Dry runs never validate. */
	validate?: boolean
	/** Attach each written file's UTF-8 text to its changeset entry. Off by default: receipts stay small. */
	includeContent?: boolean
}

function buildRecipeContext(args: {
	root: string
	packRoot: string
	manifest: PackManifest
	provider: LLMProvider | null
	onExisting: OnExisting
	dryRun: boolean
	files: ProjectFiles
	data: Readonly<Record<string, unknown>>
}): RecipeContext {
	return {
		llmProvider: args.provider,
		pack: { name: args.manifest.name, version: args.manifest.version, root: args.packRoot },
		projectRoot: args.root,
		onExisting: args.onExisting,
		dryRun: args.dryRun,
		files: args.files.api,
		data: args.data,
	}
}

function emptyCompensation(): RecipeCompensation {
	return { created: [], createdDirs: [], overwritten: [], recipeData: null }
}

/**
 * Run one declared recipe and return its receipt.
 *
 * Flow: resolve the pack and recipe; plan the templates (slots, render,
 * compare with the disk); write the plan; run `recipe.ts` if there is one;
 * validate. A failure before or during execution leaves no trace: files the
 * run created are removed and files it overwrote are restored. A validation
 * failure does not roll back; `ok` is false and `compensation` still describes
 * everything written, so the caller decides. Validation covers this recipe's
 * validators and its pack's pack-level validators only, and every
 * diagnostic they produce (warnings too) lands in `diagnostics`.
 */
export async function runRecipe(input: RunRecipeInput): Promise<RecipeResult> {
	const { registry, pack: packName, recipe: recipeId } = input
	const root = registry.root
	const dryRun = input.dryRun === true
	const provider = input.provider ?? null
	const model = input.model ?? BAKA_DEFAULT_WORKER_MODEL
	let params = input.params

	let plan: TemplatePlan = { files: [], slots: [] }
	let compensation = emptyCompensation()
	let changeset: ChangesetEntry[] = []
	let output: unknown = null
	let pins: PackPin[] = []
	// True once files were written and until the recipe (if any) succeeded.
	let uncommitted = false
	const diagnostics: ValidationDiagnostic[] = []

	const receipt = (ok: boolean): RecipeResult => ({
		ok,
		pack: packName,
		recipe: recipeId,
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
		const { packRoot, manifest, recipe } = resolveRecipe(registry, packName, recipeId)
		const templatesDir = join(packRoot, recipe.id, "templates")
		const hasTemplates = existsSync(templatesDir)
		const hasRecipe = existsSync(join(packRoot, recipe.id, "recipe.ts"))
		const pin = pinPack(packRoot, manifest)
		pins = [pin]
		if (input.lock) verifyPin(input.lock, pin)
		const normalized = normalizeParams(recipe.params, input.params)
		if (!normalized.ok) {
			throw new RecipeError("invalid-params", `params for ${packName}/${recipeId}: ${normalized.message}`)
		}
		params = normalized.params
		if (!hasTemplates && !hasRecipe) {
			throw new RecipeError("recipe-empty", `recipe "${recipeId}" has neither templates/ nor recipe.ts`)
		}
		if (dryRun && input.format) {
			throw new RecipeError(
				"dry-run-unsupported",
				"a dry run cannot format: the formatter would have to run over files that are not written",
			)
		}
		if (dryRun && hasRecipe && !recipe.supportsDryRun) {
			throw new RecipeError(
				"dry-run-unsupported",
				`recipe "${recipeId}" has a recipe.ts and does not declare supportsDryRun in its manifest; a dry run cannot virtualise its side effects`,
			)
		}

		const data = loadPackData(packRoot)

		if (hasTemplates) {
			plan = await planTemplates({
				root,
				templatesDir,
				params,
				data,
				provider,
				model,
				store: input.store ?? createDiskSlotStore(root),
				persist: !dryRun,
				slotMode: input.slots?.mode ?? "live",
				records: input.slots?.records ?? [],
				onExisting: input.onExisting ?? "skip",
			})
		}
		changeset = plan.files.map(({ path, op, contentHash, reason, mode }) => ({
			path,
			op,
			contentHash,
			...(reason ? { reason } : {}),
			...(mode ? { mode } : {}),
		}))
		const makeContext = (files: ProjectFiles): RecipeContext =>
			buildRecipeContext({
				root,
				packRoot,
				manifest,
				provider,
				onExisting: input.onExisting ?? "skip",
				dryRun,
				files,
				data,
			})

		if (dryRun) {
			let read = (path: string): string => plannedContent(plan, path)
			if (hasRecipe) {
				const projectFiles = createProjectFiles({
					root,
					onExisting: input.onExisting ?? "skip",
					dryRun: true,
					seed: new Map(
						plan.files
							.filter((f) => f.op !== "skip")
							.map((f) => [f.path, { bytes: Buffer.from(f.content), ...(f.mode ? { mode: f.mode } : {}) }]),
					),
				})
				const loaded = loadRecipe<Record<string, unknown>, unknown, unknown>(root, packRoot, manifest, recipe.id)
				const run = await executeRecipe(loaded.step, params, root, makeContext(projectFiles))
				if (run.violations.length > 0) {
					cleanDryRunViolation(root, run)
					throw new RecipeError(
						"dry-run-violation",
						`recipe "${recipeId}" changed the project during a dry run instead of writing through ctx.files: ${run.violations.join(", ")}`,
					)
				}
				if (run.failure) throw run.failure
				output = run.result?.output ?? null
				changeset = mergeRecipeChanges(changeset, [...projectFiles.entries(), ...projectFiles.ownedEntries()])
				read = (path) =>
					plan.files.some((f) => f.path === path) ? plannedContent(plan, path) : projectFiles.api.readText(path)
			}
			if (input.includeContent) changeset = withContent(changeset, read)
			return receipt(true)
		}

		const files = applyPlan(root, plan)
		uncommitted = true
		const written = plan.files.filter((f) => f.op === "create" || f.op === "update").map((f) => f.path)
		compensation = { ...files, recipeData: { written } }

		if (hasRecipe) {
			const projectFiles = createProjectFiles({ root, onExisting: input.onExisting ?? "skip", dryRun: false })
			const loaded = loadRecipe<Record<string, unknown>, unknown, unknown>(root, packRoot, manifest, recipe.id)
			const ctx = makeContext(projectFiles)
			const run = await executeRecipe(loaded.step, params, root, ctx)
			// Whatever the outcome, the engine now knows everything the recipe wrote, so a failure undoes all of it.
			compensation = {
				...mergeRollbacks(files, projectFiles.rollback(), run.created),
				recipeData: run.result ? run.result.compensationData : { written },
			}
			if (run.failure) {
				if (run.result) {
					try {
						await loaded.step.compensate(run.result.compensationData, emptyState(root), ctx)
					} catch (err) {
						diagnostics.push({
							severity: "warning",
							rule: "compensate-failed",
							message: `the recipe's own compensate failed: ${err instanceof Error ? err.message : String(err)}`,
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
			changeset = mergeRecipeChanges(changeset, [
				...run.changes,
				...projectFiles.entries(),
				...projectFiles.ownedEntries(),
			])
		}
		if (input.format && recipe.format) {
			const formatted = runFormatter(root, recipe.format, changeset)
			// The formatter may have rewritten what the run produced: the receipt describes the bytes now on disk.
			changeset = changeset.map((e) =>
				formatted.includes(e.path) ? { ...e, contentHash: hashBytes(readFileSync(join(root, e.path))) } : e,
			)
		}
		uncommitted = false
		if (input.includeContent) changeset = withContent(changeset, (path) => readFileSync(join(root, path), "utf-8"))

		if (input.validate !== false) {
			const validation = await runValidators(registry, emptyState(root), {
				mode: "recipes",
				ran: [
					{
						pack: packName,
						recipe: recipeId,
						params,
						compensationData: compensation.recipeData,
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
			err instanceof RecipeError ? err : new RecipeError("unexpected", err instanceof Error ? err.message : String(err))
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
	if (!file) throw new RecipeError("unexpected", `no planned content for "${path}"`)
	return file.content
}

/** What running a `recipe.ts` did, as the engine saw it. */
interface RecipeRun {
	result?: StepResponse<unknown, unknown>
	/** Set when `execute` threw or reported `success: false`. */
	failure?: RecipeError
	/** create/update/delete entries from hashing the project tree before and after `execute`. */
	changes: ChangesetEntry[]
	/** What undoes the files and directories the recipe created, whichever way it wrote them. */
	created: Rollback
	/** Every path the tree diff reports, plus the directories created: in a dry run, anything here is a violation. */
	violations: string[]
}

/**
 * Run `execute` with the project tree hashed before and after, so the engine
 * knows what the recipe did even when it wrote with plain `node:fs`.
 */
async function executeRecipe(
	step: RecipeStep<Record<string, unknown>, unknown, unknown>,
	params: Record<string, unknown>,
	root: string,
	ctx: RecipeContext,
): Promise<RecipeRun> {
	const filesBefore = snapshotTree(root)
	const dirsBefore = snapshotDirectories(root)
	let result: StepResponse<unknown, unknown> | undefined
	let failure: RecipeError | undefined
	try {
		result = await step.execute(params, emptyState(root), ctx)
		if (!result.success) failure = new RecipeError("recipe-failed", result.error ?? "recipe failed")
	} catch (err) {
		failure =
			err instanceof RecipeError
				? err
				: new RecipeError("recipe-failed", err instanceof Error ? err.message : String(err))
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

/** Best-effort cleanup of what a recipe wrote straight to the disk during a dry run. */
function cleanDryRunViolation(root: string, run: RecipeRun): void {
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
 * Fold what a side-effect recipe did into the template changeset. Paths the
 * templates already addressed keep their entry (a created file the recipe
 * then edited is still a create) but take the final content hash; a file the
 * recipe found unchanged or skipped leaves the template's account alone.
 * Everything else the recipe addressed is added as it is: that is how an
 * `unchanged` output of a rerun reaches the receipt and keeps its hash.
 */
function mergeRecipeChanges(planned: ChangesetEntry[], changes: ChangesetEntry[]): ChangesetEntry[] {
	const byPath = new Map(planned.map((e) => [e.path, { ...e }]))
	for (const change of changes) {
		const entry = byPath.get(change.path)
		if (!entry) {
			byPath.set(change.path, change)
		} else if (change.op === "delete") {
			byPath.set(change.path, change)
		} else if (change.op === "create" || change.op === "update") {
			entry.contentHash = change.contentHash
			if (change.mode) entry.mode = change.mode
			if (entry.op === "unchanged" || entry.op === "skip") {
				entry.op = "update"
				delete entry.reason
			}
		}
	}
	return [...byPath.values()].sort((a, b) => compareUtf8(a.path, b.path))
}

export interface CompensateRecipeInput {
	registry: PackRegistry
	pack: string
	recipe: string
	compensation: RecipeCompensation
	provider?: LLMProvider | null
}

/**
 * Undo a run from its receipt: delete what it created, restore what it
 * overwrote, then hand the recipe's own compensation data back to its
 * `compensate` (side-effect recipes only).
 */
export async function compensateRecipe(input: CompensateRecipeInput): Promise<void> {
	const { registry, compensation } = input
	revertFiles(registry.root, compensation)
	if (compensation.recipeData == null) return
	const { packRoot, manifest, recipe } = resolveRecipe(registry, input.pack, input.recipe)
	if (!existsSync(join(packRoot, recipe.id, "recipe.ts"))) return
	const loaded = loadRecipe<unknown, unknown, unknown>(registry.root, packRoot, manifest, recipe.id)
	const files = createProjectFiles({ root: registry.root, onExisting: "skip", dryRun: false })
	await loaded.step.compensate(
		compensation.recipeData,
		emptyState(registry.root),
		buildRecipeContext({
			root: registry.root,
			packRoot,
			manifest,
			provider: input.provider ?? null,
			onExisting: "skip",
			dryRun: false,
			files,
			data: loadPackData(packRoot),
		}),
	)
}
