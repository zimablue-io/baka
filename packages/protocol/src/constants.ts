// Engine state machine
export const ENGINE_STATUS = {
	IDLE: "IDLE",
	PLANNING: "PLANNING",
	EXECUTING: "EXECUTING",
	VALIDATING: "VALIDATING",
	COMPENSATING: "COMPENSATING",
	SUCCESS: "SUCCESS",
	FAILED: "FAILED",
} as const

/** @lintignore Public protocol type — engine state machine values; consumed by external tools (e.g. dashboards). */
export type EngineStatus = (typeof ENGINE_STATUS)[keyof typeof ENGINE_STATUS]

// Structured exit codes for the CLI. Picked up by the baka binary and forwarded to process.exit.
export const BAKA_EXIT_CODE = {
	SUCCESS: 0,
	USER_ERROR: 1,
	ENGINE_ERROR: 2,
	PROVIDER_ERROR: 3,
	VALIDATION_ERROR: 4,
} as const

/** @lintignore Public protocol type — the BAKA_EXIT_CODE union; consumed by external tools that read baka CLI exit codes. */
export type BakaExitCode = (typeof BAKA_EXIT_CODE)[keyof typeof BAKA_EXIT_CODE]

// Names of the providers shipped with baka. Users can register more via baka providers add.
export const BAKA_PROVIDER = {
	OPENAI_COMPATIBLE: "openai-compatible",
	PI_ADAPTER: "pi-adapter",
} as const

/** @lintignore Public protocol type — the BAKA_PROVIDER union; consumed by external tools that switch on provider names. */
export type BakaProviderName = (typeof BAKA_PROVIDER)[keyof typeof BAKA_PROVIDER]

// Reserved module categories used in docs and error messages. The set of installed
// modules is discovered at runtime from modules/*/manifest.ts; these constants
// exist only for documentation and example prompts, never for enforcement.
export const MODULE_CATEGORY = {
	BASE: "base",
	FRAMEWORK: "framework",
	AUTH: "auth",
	DATA: "data",
	UI: "ui",
	PATTERN: "pattern",
} as const

/** @lintignore Public protocol type — the MODULE_CATEGORY union; consumed by external tools and docs for module categorization. */
export type ModuleCategory = (typeof MODULE_CATEGORY)[keyof typeof MODULE_CATEGORY]

// Env var prefix. All user-facing env vars start with BAKA_.
// ASSEMBLE_* is the historical alias; not supported.
export const BAKA_ENV_PREFIX = "BAKA_"

// Reserved subpaths under the project root for per-project state.
export const BAKA_PROJECT_PATHS = {
	ROOT: ".baka",
	LOCAL_CONFIG: ".baka/local.json",
	STATE: ".baka/state",
	PLANS: ".baka/plans",
	LOGS: ".baka/logs",
} as const

// XDG-aware user paths are computed at runtime by the config loader in agent-engine.
// These are the directory names used under $XDG_CONFIG_HOME / $XDG_DATA_HOME.
export const BAKA_USER_DIR = "baka" as const

// Feature flag: enables the optional pi-coding-agent adapter in agent-engine.
// Off by default; users opt in by setting BAKA_USE_PI_ADAPTER=1.
export const BAKA_FEATURE_FLAGS = {
	PI_ADAPTER: "BAKA_USE_PI_ADAPTER",
} as const
