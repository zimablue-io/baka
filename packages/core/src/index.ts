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
	ModuleRegistry,
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
	ModuleNotFoundError,
	readLockfile,
	runAction,
	validateProject as validate,
	writeLockfile,
} from "@repo/ast-tooling"
export type {
	ActionCompensation,
	ActionErrorCode,
	ActionResult,
	BakaLock,
	ChangeOp,
	ChangesetEntry,
	LLMMessage,
	LLMProvider,
	LLMRequest,
	LLMResponse,
	ModuleManifest,
	ModulePin,
	SlotMode,
	SlotRecord,
	SlotsInput,
	ValidationDiagnostic,
} from "@repo/protocol"
export { ACTION_ERROR_CODES, BAKA_LOCKFILE_NAME } from "@repo/protocol"
export type { CreateRegistryOptions } from "./registry.js"
export { createRegistry } from "./registry.js"
