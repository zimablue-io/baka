import type { LLMMessage, LLMProvider } from "@repo/protocol"
import { type DesignTurnPayload, DesignTurnPayloadSchema } from "./payload"
import type { DesignSessionState } from "./state"

// ---------------------------------------------------------------------------
// LLM turn driver. Calls the LLM with the current state, returns the
// structured payload + the updated chat history. Pure: no state mutation.
// ---------------------------------------------------------------------------

export interface RunLLMTurnArgs {
	provider: LLMProvider
	state: DesignSessionState
}

export interface RunLLMTurnResult {
	ok: boolean
	payload?: DesignTurnPayload
	updatedHistory?: LLMMessage[]
	error?: string
}

export async function runLLMTurn({ provider, state }: RunLLMTurnArgs): Promise<RunLLMTurnResult> {
	const messages: LLMMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "system", content: `Current phase: ${state.phase}\n\n${contextSummary(state)}` },
		...state.history,
	]
	try {
		const response = await provider.chat<DesignTurnPayload>({
			model: "",
			messages,
			responseSchema: DesignTurnPayloadSchema,
			temperature: 0.2,
		})
		const payload = response.content
		const summary = `${payload.message}\n\n[phase=${payload.phase}]`
		const updatedHistory: LLMMessage[] = [...state.history, { role: "assistant", content: summary }]
		return { ok: true, payload, updatedHistory }
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
}

const SYSTEM_PROMPT = `You are the baka Module Designer. Respond with a single JSON object matching the schema for the current phase. The 'message' field is what the user sees. The structured fields drive the state machine.`

function contextSummary(input: DesignSessionState): string {
	const lines: string[] = [`User's brief: ${input.brief || "(none)"}`]
	if (input.prefs) {
		lines.push("Current PREFERENCES.md draft:")
		lines.push(input.prefs)
	}
	if (input.roster && input.roster.length > 0) {
		lines.push("Current action roster:")
		for (const a of input.roster) lines.push(`  - ${a.id}: ${a.description} (${a.rationale})`)
	}
	if (input.designedActions && input.designedActions.length > 0) {
		lines.push("Already designed actions:")
		for (const a of input.designedActions) {
			lines.push(
				`  - ${a.id}: ${a.params.length} params, ${a.validators.length} validators, requiresReasoning=${a.requiresReasoning}`,
			)
		}
	}
	return lines.join("\n")
}
