// The baka SDK is the only boundary module authors should import from.
//
// This file re-exports the small, stable set of types and runtime helpers a
// module author needs: the workflow-step contract, the agent role enum, the
// orchestration state shape, the manifest schema, the LLM client surface
// (for module validators that need the validator role's LLM), and a couple
// of exit-code constants. Everything else stays inside the engine.
//
// Modules should `import { WorkflowStep, AgentRole, callLLMAsValidator } from "baka-sdk"`,
// never reach into `@repo/protocol` or the engine internals.

export type { RoleConfig, RoleName } from "@repo/agent-engine"
export { createLLMProvider, loadLLMConfig, OpenAICompatibleProvider, SUPPORTED_ROLES } from "@repo/agent-engine"
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
export {
	AgentRole,
	BAKA_EXIT_CODE,
	BAKA_USER_DIR,
	ModuleActionParamSchema,
	ModuleActionSchema,
	ModuleManifestSchema,
} from "@repo/protocol"

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createLLMProvider, loadLLMConfig } from "@repo/agent-engine"
import type { LLMMessage } from "@repo/protocol"
import { BAKA_USER_DIR } from "@repo/protocol"
import type { z } from "zod"

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
 * secrets here directly; route those through the baka CLI's role commands.
 */
export function bakaUserDir(): string {
	return BAKA_USER_DIR
}

// ---------------------------------------------------------------------------
// Validator-role LLM helper (for module validators)
//
// The baka philosophy keeps validators deterministic TS in the hot path.
// Some validators, however, assess semantic content (coherence of a
// generated spec, quality of a generated README). For those, a validator
// can call this helper to ask the validator-role LLM to assess the
// produced content.
//
// Usage from a validator file:
//
//   import { callLLMAsValidator } from "baka-sdk"
//   import { z } from "zod"
//
//   export const myValidator = async (state) => {
//     const result = await callLLMAsValidator({
//       cwd: state.targetDirectory,
//       prompt: "Is this constitution coherent? ...",
//       responseSchema: z.object({ coherent: z.boolean(), issues: z.array(z.string()) }),
//     })
//     if (!result.coherent) return result.issues.map((m) => ({ severity: "warning", rule: "<...>", message: m }))
//     return []
//   }
// ---------------------------------------------------------------------------

/**
 * Returns an LLM provider for the validator role, configured from
 * `~/.baka/config.json`. Throws `BAKA_CONFIG_MISSING` if the validator
 * role block is absent. Modules call this once per validator invocation;
 * the provider is short-lived (one HTTP call).
 *
 * Exposed primarily so module validators that need to send multiple
 * requests can reuse a provider instance. Most validators should prefer
 * `callLLMAsValidator`, which composes load+create+chat for one-shot use.
 */
export async function loadLLMProvider(cwd: string) {
	const config = await loadLLMConfig({ role: "validator", cwd })
	return createLLMProvider(config)
}

export interface CallLLMAsValidatorOptions {
	cwd: string
	prompt: string
	system?: string
	responseSchema: z.ZodType<unknown>
}

/**
 * One-shot validator-role LLM helper. Loads the role's config, builds a
 * provider, sends the prompt with the given schema, and returns the
 * parsed content.
 *
 * The user must have configured the validator role via `baka init`. The
 * provider uses constrained decoding (`response_format: json_schema`) so
 * the returned object conforms to `responseSchema`.
 */
export async function callLLMAsValidator<T = unknown>(opts: CallLLMAsValidatorOptions): Promise<T> {
	const provider = await loadLLMProvider(opts.cwd)
	const messages: LLMMessage[] = []
	if (opts.system) messages.push({ role: "system", content: opts.system })
	messages.push({ role: "user", content: opts.prompt })
	const request = {
		model: "",
		messages,
		responseSchema: opts.responseSchema,
		temperature: 0.0,
	}
	const response = await provider.chat<T>(request)
	return response.content
}
