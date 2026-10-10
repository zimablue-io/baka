// The other packages in this monorepo (workflows/*) re-export via single named
// re-exports. `export * from` is intentionally NOT used because it does not
// load under Node's strict ESM resolver when this file is consumed via the
// package's `exports` field. Keep this in lockstep with the other packages.
//
// Relative imports use `.js` extensions because the package declares
// `"type": "module"` (NodeNext ESM resolution); TypeScript with
// `allowImportingTsExtensions` would allow `.ts`, but the runtime consumers
// (jiti, vitest, tsup) all resolve `.js` against the on-disk `.ts` source.

export type { ConsistencyOptions, ConsistencyResult, PerRunResult } from "./consistency.js"
export { cleanupConsistency, runConsistencyTest } from "./consistency.js"
export type { Catalog, CatalogPack, CatalogRecipe, ValidateResult } from "./describe-packs.js"
export { describePacks, PackNotFoundError, validateProject } from "./describe-packs.js"
export { RecipeError } from "./errors.js"
export { createLock, lockfilePath, pinPack, readLockfile, verifyPin, writeLockfile } from "./lock.js"
export type { PlannedFile, PlanTemplatesOptions, TemplatePlan } from "./materialize.js"
export { applyPlan, fillSlot, planTemplates, revertFiles } from "./materialize.js"
export {
	PACK_DIRS_ENV,
	PACK_DIRS_SETTING,
	PackDirsError,
	packDirsFromEnv,
	packDirsFromSettings,
	resolvePackDirs,
} from "./pack-dirs.js"
export type {
	BakaSettings,
	InstallOptions,
	ManifestJsonShape,
	PackageSourceType,
	ParsedSource,
	RegistryTarball,
} from "./package-manager.js"
export {
	extractRegistryTarball,
	installSource,
	listInstalledPackages,
	parseSource,
	projectPacksDir,
	projectSettingsPath,
	readProjectSettings,
	readUserSettings,
	removeSource,
	userPacksDir,
	userSettingsPath,
	verifyTarballIntegrity,
} from "./package-manager.js"
export type { SavedPlan } from "./plan-io.js"
export { listPlans, loadPlan, plansDir, savePlan } from "./plan-io.js"
export type { LoadedRecipe, PackValidatorFn, RecipeValidatorFn } from "./recipe-loader.js"
export { loadPackValidator, loadRecipe, loadRecipeValidator } from "./recipe-loader.js"
export type { PackRegistryOptions } from "./registry.js"
export { PackRegistry, validatorFilename } from "./registry.js"
export type { CompensateRecipeInput, RunRecipeInput } from "./run-recipe.js"
export { compensateRecipe, listRecipeSlots, previewRecipe, resolveRecipe, runRecipe } from "./run-recipe.js"
export type { CompletedStep, SagaResult, SagaStep } from "./saga.js"
export { ranRecipes, runSaga } from "./saga.js"
export type { SdkImportFinding } from "./sdk-imports.js"
export { findPackSdkImports, findRuntimeSdkImports } from "./sdk-imports.js"
export type { SlotCacheRecord, SlotStore } from "./slot-cache.js"
export {
	createDiskSlotStore,
	createMemorySlotStore,
	projectSlotsDir,
	readSlotCache,
	userSlotsDir,
	writeSlotCache,
} from "./slot-cache.js"
export {
	canonicalJson,
	hashBytes,
	parseRecipeTemplates,
	parseSlots,
	renderTemplate,
	SlotTemplateError,
	slotCacheKey,
	slotRecordKey,
	slotTemplateKey,
} from "./slots.js"
export type { LogEntry, LogLevel } from "./structured-log.js"
export { StructuredLog } from "./structured-log.js"
export { compareUtf8, diffSnapshots, outputTreeHash, packContentHash, sha256Hex, snapshotTree } from "./tree-hash.js"
export type { RanRecipe, ValidationScope } from "./validator.js"
export { runValidators } from "./validator.js"
export type { WorkerInput, WorkerRollbackData } from "./worker.js"
export { executeWorkerStep } from "./worker.js"
