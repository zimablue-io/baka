/**
 * @baka/core: the embeddable surface of the Baka engine.
 *
 * Nothing here reads `${BAKA_HOME:-$HOME/.baka}` (config, user marketplace,
 * user slot cache) unless the caller opts in, and nothing here knows about a
 * CLI or an LLM vendor: the caller injects an `LLMProvider`.
 */
export type {
	Catalog,
	CatalogAction,
	CatalogModule,
	CompensateActionInput,
	ModuleRegistryOptions,
	RunActionInput,
	SlotCacheRecord,
	SlotStore,
	ValidateResult,
} from "@repo/ast-tooling"
export {
	compensateAction,
	createDiskSlotStore,
	createLock,
	createMemorySlotStore,
	describeModules,
	MODULE_DIRS_ENV,
	MODULE_DIRS_SETTING,
	ModuleDirsError,
	ModuleNotFoundError,
	ModuleRegistry,
	moduleDirsFromEnv,
	moduleDirsFromSettings,
	readLockfile,
	resolveModuleDirs,
	runAction,
	TREE_HASH_DOMAIN,
	validateProject as validate,
	writeLockfile,
} from "@repo/ast-tooling"
export type {
	ActionCompensation,
	ActionContext,
	ActionErrorCode,
	ActionFiles,
	ActionFileWrite,
	ActionResult,
	ActionStep,
	ActionWriteOptions,
	BakaLock,
	ChangeOp,
	ChangesetEntry,
	LLMMessage,
	LLMProvider,
	LLMRequest,
	LLMResponse,
	ModuleManifest,
	ModulePin,
	OnExisting,
	OrchestrationState,
	SlotMode,
	SlotRecord,
	SlotsInput,
	ValidationDiagnostic,
	ValidationResult,
	ValidatorRun,
} from "@repo/protocol"
export { ACTION_ERROR_CODES, BAKA_LOCKFILE_NAME, PARAM_FORMATS } from "@repo/protocol"
export type { CreateRegistryOptions } from "./registry.js"
export { createRegistry } from "./registry.js"
