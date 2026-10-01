import type { ActionErrorCode } from "@repo/protocol"

/**
 * A failure with a stable, typed code. `runAction` turns it into an error
 * diagnostic whose `rule` is the code, so callers never parse messages.
 */
export class ActionError extends Error {
	constructor(
		readonly code: ActionErrorCode,
		message: string,
	) {
		super(message)
		this.name = "ActionError"
	}
}
