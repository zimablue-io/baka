import type { RecipeErrorCode } from "@repo/protocol"

/**
 * A failure with a stable, typed code. `runRecipe` turns it into an error
 * diagnostic whose `rule` is the code, so callers never parse messages.
 */
export class RecipeError extends Error {
	constructor(
		readonly code: RecipeErrorCode,
		message: string,
	) {
		super(message)
		this.name = "RecipeError"
	}
}
