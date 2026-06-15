// The baka SDK is the only boundary module authors should import from.
//
// This file re-exports the small, stable set of types and runtime helpers a
// module author needs: the workflow-step contract, the agent role enum, the
// orchestration state shape, the manifest schema, and a couple of exit-code
// constants. Everything else stays inside the engine.
//
// Modules should `import { WorkflowStep, AgentRole } from "baka-sdk"`, never
// reach into `@repo/protocol` or the engine internals.

export {
	AgentRole,
	BAKA_EXIT_CODE,
	BAKA_USER_DIR,
} from "@repo/protocol"
export type {
	LLMMessage,
	LLMProvider,
	LLMRequest,
	LLMResponse,
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
} from "@repo/protocol"
export { ModuleActionParamSchema, ModuleActionSchema, ModuleManifestSchema } from "@repo/protocol"

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { BAKA_USER_DIR } from "@repo/protocol"

/**
 * Returns the absolute path of the project's baka state directory, creating
 * the parent chain on demand. Modules can use this when their action's
 * compensation needs to stage a file outside the user's tree.
 */
export function bakaProjectPaths(cwd: string): { root: string; plans: string; state: string; logs: string } {
	const root = join(cwd, ".baka")
	return {
		root,
		plans: join(root, "plans"),
		state: join(root, "state"),
		logs: join(root, "logs"),
	}
}

/**
 * Reads the contents of a file, returning `undefined` if the file does not
 * exist. Convenience helper for validators and idempotent actions.
 */
export function readIfExists(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf-8") : undefined
}

/**
 * Returns the user-level baka config directory. Modules should not write
 * secrets here directly; route those through the baka CLI's provider commands.
 */
export function bakaUserDir(): string {
	return BAKA_USER_DIR
}
