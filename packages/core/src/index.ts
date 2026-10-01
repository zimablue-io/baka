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
	ModuleRegistry,
	RunActionInput,
	RunActionResult,
	SlotCacheRecord,
	SlotStore,
	ValidateResult,
} from "@repo/ast-tooling"
export {
	createDiskSlotStore,
	createMemorySlotStore,
	describeModules,
	ModuleNotFoundError,
	runAction,
	validateProject as validate,
} from "@repo/ast-tooling"
export type {
	LLMMessage,
	LLMProvider,
	LLMRequest,
	LLMResponse,
	ModuleManifest,
	ValidationDiagnostic,
} from "@repo/protocol"
export type { CreateRegistryOptions } from "./registry.js"
export { createRegistry } from "./registry.js"
