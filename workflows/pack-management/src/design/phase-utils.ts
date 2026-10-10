import { type DesignPhase, type DesignSessionState, setPhase } from "./state"

// ---------------------------------------------------------------------------
// Phase-jump helper. Used by the CLI's /back command to rewind the state
// machine to a prior phase.
// ---------------------------------------------------------------------------

export function applyBack(state: DesignSessionState, phase: DesignPhase): DesignSessionState {
	return setPhase(state, phase)
}
