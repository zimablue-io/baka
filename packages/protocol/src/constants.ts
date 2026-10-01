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
	SLOTS: ".baka/slots",
} as const

/**
 * The one worker-model id Baka pins. llama.cpp on this machine serves
 * `gemma4-e4b` with alias `gemma4:e4b`. Callers use the alias (the product
 * name). Dual keys (`e4b-it`, `gemma4-12b-qat`) are forbidden.
 */
export const BAKA_DEFAULT_WORKER_MODEL = "gemma4:e4b" as const

// The directory name used under the user's home directory for config and data.
export const BAKA_USER_DIR = "baka" as const

// Typed failure codes of `runAction`. A failed run carries one error
// diagnostic whose `rule` is one of these, so callers branch on a stable
// string instead of parsing a message.
export const ACTION_ERROR_CODES = [
	"module-not-found",
	"module-invalid",
	"action-not-found",
	"action-empty",
	"invalid-params",
	"lock-mismatch",
	"lock-unlisted",
	"slot-no-provider",
	"slot-provider-error",
	"slot-record-missing",
	"slot-record-stale",
	"slot-fill-invalid",
	"template-invalid",
	"target-exists",
	"dry-run-unsupported",
	"action-failed",
	"unexpected",
] as const

// Where a project records the module versions it is pinned to; see docs/MODULES.md.
export const BAKA_LOCKFILE_NAME = "baka.lock.json"
