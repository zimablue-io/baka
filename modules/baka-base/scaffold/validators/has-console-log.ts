import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState, ValidationDiagnostic } from "baka-sdk"

/**
 * Action-level validator for `baka-base.scaffold`.
 *
 * Asserts that the produced `src/index.ts` actually contains a `console.log`
 * call. The action's compensation data carries `createdFiles` (the absolute
 * paths the action wrote); we look for the index entry there.
 */
export async function hasConsoleLog(state: OrchestrationState, actionData: unknown): Promise<ValidationDiagnostic[]> {
	const diagnostics: ValidationDiagnostic[] = []
	const created = (actionData as { createdFiles?: string[] } | null | undefined)?.createdFiles ?? []
	const indexFile = created.find((f) => f.endsWith("src/index.ts")) ?? join(state.targetDirectory, "src", "index.ts")
	if (!existsSync(indexFile)) {
		diagnostics.push({
			severity: "error",
			rule: "has-console-log",
			message: `scaffold produced no src/index.ts at ${indexFile}`,
		})
		return diagnostics
	}
	const text = readFileSync(indexFile, "utf-8")
	if (!/console\.log\(/.test(text)) {
		diagnostics.push({
			severity: "error",
			rule: "has-console-log",
			message: `${indexFile} does not contain a console.log call; the hello-world scaffold is broken`,
		})
	}
	return diagnostics
}
