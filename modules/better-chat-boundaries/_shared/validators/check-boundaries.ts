import { resolve } from "node:path"
import type { OrchestrationState, ValidationDiagnostic } from "baka-sdk"
import { runBoundaryCheck } from "../helpers/run-check"

/**
 * Module-level validator for `better-chat-boundaries`. Runs the legacy
 * `scripts/check-boundaries.mjs` in a sandboxed temp dir against the
 * live better-chat source (the user is expected to invoke `baka validate`
 * from the better-chat root, so `state.targetDirectory` is that root).
 *
 * Returns an empty diagnostics list on a clean pass; returns the
 * structured violation list (`{file, hint: forbiddenImport=...}`)
 * injected by the boundary check script on a fail. Never mutates
 * the live source — see `_shared/helpers/run-check.ts` for the
 * sandbox construction.
 */
export async function checkBoundaries(state: OrchestrationState): Promise<ValidationDiagnostic[]> {
	const betterChatRoot = state.targetDirectory?.length ? resolve(state.targetDirectory) : resolve(process.cwd())
	const result = await runBoundaryCheck(betterChatRoot)
	return result.diagnostics
}
