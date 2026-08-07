// The other packages in this monorepo (workflows/*) re-export via single named
// re-exports, e.g. `export { featurePlanningWorkflow } from "./plan-intent"`.
// `export * from` is intentionally NOT used because it does not load under
// Node's strict ESM resolver when this file is consumed via the package's
// `exports` field. Keep this in lockstep with the other packages.

export { bakaHomeDir } from "./baka-home"
export { BUILT_IN_CATALOG } from "./built-in-catalog"
export type {
	AggregateRequest,
	AggregateResponse,
	ApiCatalog,
	ApiModuleEntry,
	Catalog,
	CatalogError,
	CatalogOwner,
	ModuleEntry,
	ModuleLookupResponse,
	Tier,
	VerifiedCatalogEntry,
	VerifiedResponse,
} from "./catalog"
export {
	AggregateRequestSchema,
	AggregateResponseSchema,
	ApiCatalogSchema,
	ApiModuleEntrySchema,
	CatalogErrorSchema,
	CatalogOwnerSchema,
	CatalogSchema,
	ModuleEntrySchema,
	ModuleLookupResponseSchema,
	TIER_VALUES,
	VerifiedCatalogEntrySchema,
	VerifiedResponseSchema,
} from "./catalog"
export {
	BAKA_EXIT_CODE,
	BAKA_PROJECT_PATHS,
	BAKA_USER_DIR,
	ENGINE_STATUS,
	MODULE_CATEGORY,
} from "./constants"
export type { RegistryConfigMap, RegistryCredential } from "./registry-config"
export {
	normalizeRegistryUrl,
	RegistryConfigMapSchema,
	RegistryCredentialSchema,
} from "./registry-config"

export {
	ModuleActionParamSchema,
	ModuleActionSchema,
	ModuleManifestSchema,
	OrchestrationStateSchema,
	ResolvedPlanSchema,
	ResolvedPlanStepSchema,
} from "./schemas"
export type {
	LLMMessage,
	LLMMessageRole,
	LLMProvider,
	LLMRequest,
	LLMResponse,
	LLMUsage,
	ModuleAction,
	ModuleActionParam,
	ModuleManifest,
	OrchestrationState,
	ResolvedLLMConfig,
	ResolvedPlan,
	StepContext,
	StepResponse,
	ValidationDiagnostic,
	ValidationResult,
	WorkflowStep,
} from "./types"
export { AgentRole } from "./types"
