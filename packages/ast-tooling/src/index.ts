// The other packages in this monorepo (workflows/*) re-export via single named
// re-exports. `export * from` is intentionally NOT used because it does not
// load under Node's strict ESM resolver when this file is consumed via the
// package's `exports` field. Keep this in lockstep with the other packages.
//
// Relative imports use `.js` extensions because the package declares
// `"type": "module"` (NodeNext ESM resolution); TypeScript with
// `allowImportingTsExtensions` would allow `.ts`, but the runtime consumers
// (jiti, vitest, tsup) all resolve `.js` against the on-disk `.ts` source.

export type { ActionValidatorFn, LoadedAction, ModuleValidatorFn } from "./action-loader.js"
export { loadAction, loadActionValidator, loadModuleValidator } from "./action-loader.js"
export type { ConsistencyOptions, ConsistencyResult, PerRunResult } from "./consistency.js"
export { cleanupConsistency, runConsistencyTest } from "./consistency.js"
export type { MaterializeOptions, MaterializeResult } from "./materialize.js"
export { fillSlot, materializeTemplates } from "./materialize.js"
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
	projectModulesDir,
	projectSettingsPath,
	readProjectSettings,
	readUserSettings,
	removeSource,
	userModulesDir,
	userSettingsPath,
	verifyTarballIntegrity,
} from "./package-manager.js"
export type { SavedPlan } from "./plan-io.js"
export { listPlans, loadPlan, plansDir, savePlan } from "./plan-io.js"
export { ModuleRegistry, validatorFilename } from "./registry.js"
export type { RunNamedActionInput, RunNamedActionResult } from "./run-action.js"
export { listActionSlots, previewAction, resolveAction, runNamedAction } from "./run-action.js"
export type { CompletedStep, SagaResult, SagaStep } from "./saga.js"
export { runSaga } from "./saga.js"
export type { SlotCacheRecord } from "./slot-cache.js"
export { projectSlotsDir, readSlotCache, userSlotsDir, writeSlotCache } from "./slot-cache.js"
export {
	canonicalJson,
	hashBytes,
	parseActionTemplates,
	parseSlots,
	renderTemplate,
	SlotTemplateError,
	slotCacheKey,
} from "./slots.js"
export type { LogEntry, LogLevel } from "./structured-log.js"
export { StructuredLog } from "./structured-log.js"
export { runValidators } from "./validator.js"
export type { WorkerInput, WorkerRollbackData } from "./worker.js"
export { executeWorkerStep } from "./worker.js"
