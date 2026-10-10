import { ApiErrorSchema, BAKA_EXIT_CODE, type LlmCall } from "@repo/protocol"
import { die } from "./die"

/** What every command that reaches the engine is called with: where, which packs, and what it may read. */
export interface CallOptions {
	cwd: string
	packDirs?: string[]
	/** Read nothing from the machine's user directory (`--isolated`). */
	isolated?: boolean
	/** The model this call uses (`--llm-*`, `BAKA_LLM_*`). */
	llm?: LlmCall
	/** The packs that ship with the installed CLI. */
	bundledPacksDir?: string
}

export function engineInit(opts: CallOptions) {
	return { packDirs: opts.packDirs, isolated: opts.isolated, llm: opts.llm, bundledPacksDir: opts.bundledPacksDir }
}

/** The options a `PackRegistry` takes for the same call, so every command sees the same set of packs. */
export function registryOptions(opts: Pick<CallOptions, "packDirs" | "isolated" | "bundledPacksDir">) {
	return { packDirs: opts.packDirs, userScope: !opts.isolated, bundledDir: opts.bundledPacksDir }
}

/**
 * Ends the command when the engine answered with an error document instead of a result. The exit
 * code follows the status: a refused request is bad input, a missing capability is unavailable,
 * anything else is a failure.
 */
export function dieOnApiError(status: number, json: unknown): void {
	const parsed = ApiErrorSchema.safeParse(json)
	if (!parsed.success) return
	const { code, message, hint } = parsed.data.error
	const exit =
		status === 501 ? BAKA_EXIT_CODE.UNAVAILABLE : status >= 500 ? BAKA_EXIT_CODE.FAILED : BAKA_EXIT_CODE.BAD_INPUT
	die(exit, message, { code, hint })
}
