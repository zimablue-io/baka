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
export { loadAction, loadActionValidator, loadModuleValidator, loadSharedHelper } from "./action-loader.js"
export type { ConsistencyOptions, ConsistencyResult, PerRunResult } from "./consistency.js"
export { cleanupConsistency, runConsistencyTest } from "./consistency.js"
export type { CatalogSubscriptions } from "./marketplace-catalogs.js"
export {
	addCatalogSubscription,
	readCatalogSubscriptions,
	removeCatalogSubscription,
	userCatalogsPath,
	writeCatalogSubscriptions,
} from "./marketplace-catalogs.js"
export type { BakaSettings, InstallOptions, PackageSourceType, ParsedSource } from "./package-manager.js"
export {
	installSource,
	listInstalledPackages,
	parseSource,
	projectModulesDir,
	projectSettingsPath,
	readProjectSettings,
	readUserSettings,
	removeSource,
	updateAll,
	userModulesDir,
	userSettingsPath,
} from "./package-manager.js"
export type { SavedPlan } from "./plan-io.js"
export { listPlans, loadPlan, plansDir, savePlan } from "./plan-io.js"
export { ModuleRegistry, validatorFilename } from "./registry.js"
export type { CompletedStep, SagaResult, SagaStep } from "./saga.js"
export { runSaga } from "./saga.js"
export type { LogEntry, LogLevel } from "./structured-log.js"
export { StructuredLog } from "./structured-log.js"
export { runValidators } from "./validator.js"
export type { WorkerInput, WorkerRollbackData } from "./worker.js"
export { executeWorkerStep } from "./worker.js"
