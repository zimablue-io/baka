import type { DesignTurnPayload } from "./payload"
import { type DesignSessionState, setPhase, touch } from "./state"

// ---------------------------------------------------------------------------
// Pure state transitions. Given the LLM's payload and the current state,
// returns a new state. No I/O, no hooks, no LLM.
// ---------------------------------------------------------------------------

export interface ApplyPayloadResult {
	phaseChanged: boolean
	advanced: boolean
	delivered: boolean
}

export function applyPayload(
	state: DesignSessionState,
	payload: DesignTurnPayload,
): { state: DesignSessionState; result: ApplyPayloadResult } {
	const result: ApplyPayloadResult = { phaseChanged: false, advanced: false, delivered: false }
	switch (payload.phase) {
		case "DISCOVER": {
			if (payload.finished && payload.synthesizedPrefs) {
				state = { ...state, prefs: payload.synthesizedPrefs }
				state = setPhase(state, "DEFINE")
				result.phaseChanged = true
				result.advanced = true
			}
			break
		}
		case "DEFINE": {
			state = {
				...state,
				roster: payload.actions.map((a) => ({ id: a.id, description: a.description, rationale: a.rationale })),
			}
			if (payload.finished) {
				state = setPhase(state, "DEVELOP")
				result.phaseChanged = true
				result.advanced = true
			}
			break
		}
		case "DEVELOP": {
			const designed = payload.actions.map((a) => ({
				id: a.id,
				description: state.roster?.find((r) => r.id === a.id)?.description ?? a.id,
				params: a.params.map((p) => ({
					name: p.name,
					type: p.type,
					required: p.required,
					description: p.description,
					...(p.enumValues ? { enumValues: p.enumValues } : {}),
				})),
				requiresReasoning: a.requiresReasoning,
				compensatesWith: a.compensatesWith ?? null,
				validators: a.validators.map((v) => ({ id: v.id, purpose: v.purpose })),
				...(a.templates && a.templates.length > 0
					? { templates: a.templates.map((t) => ({ id: t.id, outline: t.outline })) }
					: {}),
				testIntent: a.testIntent,
			}))
			state = { ...state, designedActions: designed }
			if (payload.finished) {
				state = setPhase(state, "DELIVER")
				result.phaseChanged = true
				result.advanced = true
			}
			break
		}
		case "DELIVER": {
			result.delivered = true
			break
		}
	}
	return { state: touch(state), result }
}
