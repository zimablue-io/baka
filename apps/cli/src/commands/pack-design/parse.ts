// ---------------------------------------------------------------------------
// Pure decision functions. String in, decision out. No I/O, no side
// effects. These are what the user typed mapped to the workflow's
// expected resume() shape.
// ---------------------------------------------------------------------------

export type DefineApproval = { approved: boolean; note?: string }
export type DevelopApproval = { approved: boolean; edits?: string }
export type DeliverApproval = { approved: boolean }

/**
 * Parse the answer to "approve the roster? (yes / no <reason>)".
 *
 * - `null` (inquirer was force-closed) → rejected, "user force-closed"
 * - "y", "yes", "yep", "go", "approve" (any case) → approved
 * - "no <reason>" → rejected with the reason
 * - bare "no" → rejected with a sentinel "no reason given" so the LLM
 *   can ask the user for a reason
 * - anything else → rejected, treated as the note
 */
export function parseDefineApproval(answer: string | null): DefineApproval {
	if (answer === null) return { approved: false, note: "user force-closed" }
	const trimmed = answer.trim().toLowerCase()
	if (trimmed.startsWith("y") || trimmed === "go" || trimmed === "approve") {
		return { approved: true, note: answer }
	}
	if (trimmed === "no") return { approved: false, note: "no reason given" }
	const note = trimmed.startsWith("no ") ? answer.slice(3).trim() : answer
	return { approved: false, note: note || "no reason given" }
}

/**
 * Parse the answer to "approve the design? (yes / edit <text>)".
 *
 * - `null` → rejected, "user force-closed"
 * - "y", "yes", "go", "approve" (any case) → approved
 * - bare "edit" → rejected with a sentinel "no edits specified"
 * - "edit <text>" → rejected with the edit
 * - anything else → rejected, treated as the edit
 */
export function parseDevelopApproval(answer: string | null): DevelopApproval {
	if (answer === null) return { approved: false, edits: "user force-closed" }
	const trimmed = answer.trim().toLowerCase()
	if (trimmed.startsWith("y") || trimmed === "go" || trimmed === "approve") {
		return { approved: true }
	}
	if (trimmed === "edit") return { approved: false, edits: "no edits specified" }
	const edits = trimmed.startsWith("edit ") ? answer.slice(5).trim() : answer
	return { approved: false, edits: edits || "no edits specified" }
}

/**
 * Parse the answer to "proceed? (yes / no)".
 *
 * - `null` → rejected
 * - "y", "yes", "go" (any case) → approved
 * - anything else → rejected
 */
export function parseDeliverApproval(answer: string | null): DeliverApproval {
	if (answer === null) return { approved: false }
	const trimmed = answer.trim().toLowerCase()
	if (trimmed.startsWith("y") || trimmed === "go") return { approved: true }
	return { approved: false }
}
