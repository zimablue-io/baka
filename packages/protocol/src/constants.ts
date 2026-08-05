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

// Structured exit codes for the CLI. Picked up by the baka binary and forwarded to process.exit.
export const BAKA_EXIT_CODE = {
	SUCCESS: 0,
	USER_ERROR: 1,
	ENGINE_ERROR: 2,
	PROVIDER_ERROR: 3,
	VALIDATION_ERROR: 4,
} as const

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

// Reserved subpaths under the project root for per-project state.
export const BAKA_PROJECT_PATHS = {
	ROOT: ".baka",
	LOCAL_CONFIG: ".baka/config.json",
	STATE: ".baka/state",
	PLANS: ".baka/plans",
	LOGS: ".baka/logs",
} as const

// The directory name used under the user's home directory for config and data.
export const BAKA_USER_DIR = "baka" as const
