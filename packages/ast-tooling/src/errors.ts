import type { OpenSlot, RecipeErrorCode } from "@repo/protocol"

/**
 * A failure with a stable, typed code. `runRecipe` turns it into an error
 * diagnostic whose `rule` is the code, so callers never parse messages.
 * `slots-open` also carries the slots still needing a value.
 */
export class RecipeError extends Error {
	constructor(
		readonly code: RecipeErrorCode,
		message: string,
		readonly openSlots?: readonly OpenSlot[],
	) {
		super(message)
		this.name = "RecipeError"
	}
}
