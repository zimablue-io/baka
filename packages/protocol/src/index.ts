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
	ACTION_ERROR_CODES,
	BAKA_DEFAULT_WORKER_MODEL,
	BAKA_EXIT_CODE,
	BAKA_PROJECT_PATHS,
	BAKA_USER_DIR,
	ENGINE_STATUS,
	MODULE_CATEGORY,
} from "./constants"
export type { JsonSchema } from "./json-schema"
export { actionResultJsonSchema, paramsJsonSchema } from "./json-schema"
export type { NormalizedParams } from "./params"
export { normalizeParams } from "./params"
export type {
	RegistryActionPreview,
	RegistryArtifact,
	RegistryCatalogEntry,
	RegistryConfigMap,
	RegistryCredential,
	RegistryModuleDetail,
	RegistryPreviewEntry,
	RegistryPreviewListResponse,
	RegistryPreviewState,
	RegistryTier,
	RegistryVersionDetail,
	RegistryVersionStatus,
	RegistryVersionSummary,
	RegistryVisibility,
} from "./registry-config"
export {
	DEFAULT_REGISTRY_URL,
	normalizeRegistryUrl,
	REGISTRY_PREVIEW_STATES,
	REGISTRY_TIERS,
	REGISTRY_VERSION_STATUSES,
	REGISTRY_VISIBILITIES,
	RegistryActionPreviewSchema,
	RegistryArtifactSchema,
	RegistryCatalogEntrySchema,
	RegistryCatalogResponseSchema,
	RegistryConfigMapSchema,
	RegistryCredentialSchema,
	RegistryModuleDetailSchema,
	RegistryPreviewEntrySchema,
	RegistryPreviewListResponseSchema,
	RegistryScreeningSchema,
	RegistryVersionDetailSchema,
	RegistryVersionSummarySchema,
	resolveRegistryUrlList,
	resolveSingleRegistryUrl,
} from "./registry-config"

export {
	ActionCompensationSchema,
	ActionErrorCodeSchema,
	ActionResultSchema,
	ChangeOpSchema,
	ChangeReasonSchema,
	ChangesetEntrySchema,
	ModuleActionParamSchema,
	ModuleActionSchema,
	ModuleManifestSchema,
	OrchestrationStateSchema,
	PARAM_TYPES,
	ParamTypeNodeSchema,
	paramsToZod,
	ResolvedPlanSchema,
	ResolvedPlanStepSchema,
	SlotDeclSchema,
	SlotFillSchema,
	SlotKindSchema,
	SlotModeSchema,
	SlotRecordSchema,
	SlotsInputSchema,
	ValidationDiagnosticSchema,
} from "./schemas"
export type {
	ActionCompensation,
	ActionErrorCode,
	ActionResult,
	ChangeOp,
	ChangesetEntry,
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
	ParamTypeNode,
	ResolvedLLMConfig,
	ResolvedPlan,
	SlotDecl,
	SlotMode,
	SlotRecord,
	SlotsInput,
	StepContext,
	StepResponse,
	ValidationDiagnostic,
	ValidationResult,
	WorkflowStep,
} from "./types"
export { AgentRole } from "./types"
