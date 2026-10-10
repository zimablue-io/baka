import { BAKA_EXIT_CODE } from "@repo/protocol"

/** Whether the caller asked for machine-readable output; errors then follow the same rule as results. */
function wantsJson(): boolean {
	return process.argv.includes("--json")
}

function defaultErrorCode(exitCode: number): string {
	if (exitCode === BAKA_EXIT_CODE.BAD_INPUT) return "bad-request"
	if (exitCode === BAKA_EXIT_CODE.UNAVAILABLE) return "unavailable"
	return "failed"
}

/**
 * End the command with `exitCode`. The message goes to stderr for people and logs; with `--json` the
 * same failure is also written to stdout as `{ "error": { "code", "message", "hint"? } }`, the one
 * error shape the HTTP service answers with, so a caller parses one document whether the run worked or not.
 */
export function die(exitCode: number, message: string, detail?: { code?: string; hint?: string }): never {
	process.stderr.write(`baka: ${message}\n`)
	if (wantsJson()) {
		const error = {
			code: detail?.code ?? defaultErrorCode(exitCode),
			message,
			...(detail?.hint ? { hint: detail.hint } : {}),
		}
		process.stdout.write(`${JSON.stringify({ error }, null, 2)}\n`)
	}
	process.exit(exitCode)
}
