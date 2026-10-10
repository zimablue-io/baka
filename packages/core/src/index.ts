/**
 * @baka/core: the embeddable surface of the Baka engine.
 *
 * Nothing here reads `${BAKA_HOME:-$HOME/.baka}` (config, user marketplace,
 * user slot cache) unless the caller opts in, and nothing here knows about a
 * CLI or an LLM vendor: the caller injects an `LLMProvider`.
 */
export type {
	Catalog,
	CatalogPack,
	CatalogRecipe,
	CompensateRecipeInput,
	PackRegistryOptions,
	RunRecipeInput,
	SlotCacheRecord,
	SlotStore,
	ValidateResult,
} from "@repo/ast-tooling"
export {
	compensateRecipe,
	createDiskSlotStore,
	createLock,
	createMemorySlotStore,
	describePacks,
	PACK_DIRS_ENV,
	PACK_DIRS_SETTING,
	PackDirsError,
	PackNotFoundError,
	PackRegistry,
	packDirsFromEnv,
	packDirsFromSettings,
	readLockfile,
	resolvePackDirs,
	runRecipe,
	validateProject as validate,
	writeLockfile,
} from "@repo/ast-tooling"
export type {
	BakaLock,
	ChangeOp,
	ChangesetEntry,
	LLMMessage,
	LLMProvider,
	LLMRequest,
	LLMResponse,
	OnExisting,
	OrchestrationState,
	PackManifest,
	PackPin,
	RecipeCompensation,
	RecipeContext,
	RecipeErrorCode,
	RecipeFiles,
	RecipeFileWrite,
	RecipeResult,
	RecipeStep,
	RecipeWriteOptions,
	SlotMode,
	SlotRecord,
	SlotsInput,
	ValidationDiagnostic,
	ValidationResult,
	ValidatorRun,
} from "@repo/protocol"
export { BAKA_LOCKFILE_NAME, PARAM_FORMATS, RECIPE_ERROR_CODES } from "@repo/protocol"
export type { CreateRegistryOptions } from "./registry.js"
export { createRegistry } from "./registry.js"
