// The other packages in this monorepo (workflows/*) re-export via single named
// re-exports. `export * from` is intentionally NOT used because it does not
// load under Node's strict ESM resolver when this file is consumed via the
// package's `exports` field. Keep this in lockstep with the other packages.

export { ModuleRegistry } from "./registry"
export { loadAction, loadActionValidator, loadModuleValidator, loadSharedHelper } from "./action-loader"
export type { LoadedAction, ModuleValidatorFn, ActionValidatorFn } from "./action-loader"
export { executeWorkerStep } from "./worker"
export type { WorkerInput, WorkerRollbackData } from "./worker"
export { runSaga } from "./saga"
export type { SagaStep, SagaResult, CompletedStep } from "./saga"
export { runValidators } from "./validator"
export { loadPlan, listPlans, plansDir, savePlan } from "./plan-io"
export type { SavedPlan } from "./plan-io"
export { StructuredLog } from "./structured-log"
export type { LogEntry, LogLevel } from "./structured-log"
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
} from "./package-manager"
export type { BakaSettings, InstallOptions, ParsedSource, PackageSourceType } from "./package-manager"
export { cleanupConsistency, runConsistencyTest } from "./consistency"
export type { ConsistencyOptions, ConsistencyResult, PerRunResult } from "./consistency"
