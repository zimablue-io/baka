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

// Exit codes of the baka CLI, the same four the Moralo module manifest (v0) names. 0 means success,
// 1 means the command ran and the work failed (a validator, a conflict, an engine error), 2 means the
// caller's input was bad (a flag, a path, a recipe that does not exist), 3 means Baka or something it
// needs is not available (no reachable model, an incompatible host). Nothing else is ever returned.
export const BAKA_EXIT_CODE = {
	SUCCESS: 0,
	FAILED: 1,
	BAD_INPUT: 2,
	UNAVAILABLE: 3,
} as const

// Reserved pack categories used in docs and error messages. The set of installed
// packs is discovered at runtime from packs/*/manifest.ts; these constants
// exist only for documentation and example prompts, never for enforcement.
export const PACK_CATEGORY = {
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

// Typed failure codes of `runRecipe`. A failed run carries one error
// diagnostic whose `rule` is one of these, so callers branch on a stable
// string instead of parsing a message.
export const RECIPE_ERROR_CODES = [
	"pack-not-found",
	"pack-invalid",
	"recipe-not-found",
	"recipe-ambiguous",
	"recipe-empty",
	"invalid-params",
	"lock-mismatch",
	"lock-unlisted",
	"slots-open",
	"slot-unknown",
	"slot-provider-error",
	"slot-record-missing",
	"slot-record-stale",
	"slot-fill-invalid",
	"template-invalid",
	"path-escape",
	"target-exists",
	"dry-run-unsupported",
	"dry-run-violation",
	"addon-refused",
	"format-failed",
	"recipe-failed",
	"unexpected",
] as const

const BAD_INPUT_RULES: ReadonlySet<string> = new Set([
	"pack-not-found",
	"recipe-not-found",
	"recipe-ambiguous",
	"invalid-params",
	"slot-unknown",
])

/**
 * The exit code a failed run maps to, from the rule of its first error diagnostic: a pack, a recipe,
 * a parameter or a slot the caller named wrongly is bad input (2); a model that could not be reached
 * means the thing the run needs is not available (3); every other failure is a run that ran and
 * failed (1), including slots that are still open.
 */
export function exitCodeForRule(rule: string | undefined): number {
	if (rule !== undefined && BAD_INPUT_RULES.has(rule)) return BAKA_EXIT_CODE.BAD_INPUT
	if (rule === "slot-provider-error") return BAKA_EXIT_CODE.UNAVAILABLE
	return BAKA_EXIT_CODE.FAILED
}

// Where a project records the pack versions it is pinned to; see docs/PACKS.md.
export const BAKA_LOCKFILE_NAME = "baka.lock.json"
