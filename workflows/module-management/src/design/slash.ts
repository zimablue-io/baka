import type { ChatLoopHooks } from "./chat"
import { type DesignPhase, type DesignSessionState, setPhase } from "./state"

// ---------------------------------------------------------------------------
// Slash command handling inside the chat loop. Slash commands are a
// fast-path escape hatch: they don't need an LLM call, they manipulate
// the state machine directly.
//
// /exit      quit the loop
// /save      persist state
// /show      display prefs|actions|<action-id>
// /rewind    pop the last user/assistant pair
// /back <p>  jump to phase p
// /skip      advance to the next phase
// /consistency [n] [intent]   run the 5x consistency test on the first
//                            designed action
// /validate  placeholder
// /help      list commands
// ---------------------------------------------------------------------------

export type SlashLoopResult =
	| { kind: "ok" }
	| { kind: "exit" }
	| { kind: "rewound" }
	| { kind: "skip" }
	| { kind: "consistency-result" }
	| { kind: "phase-changed"; phase: DesignPhase }
	| { kind: "noop" }

export async function handleSlashInLoop(
	text: string,
	state: DesignSessionState,
	hooks: ChatLoopHooks,
): Promise<SlashLoopResult> {
	const trimmed = text.trim()
	if (!trimmed.startsWith("/")) return { kind: "noop" }
	const parts = trimmed.slice(1).split(/\s+/)
	const cmd = parts[0]?.toLowerCase() ?? ""

	switch (cmd) {
		case "exit":
		case "quit":
		case "q":
			return { kind: "exit" }
		case "save":
		case "show":
		case "rewind":
		case "undo":
		case "validate":
		case "help":
		case "?":
			hooks.onStateChanged?.(state)
			return { kind: "ok" }
		case "back": {
			const target = (parts[1] ?? "").toUpperCase()
			if (!["DISCOVER", "DEFINE", "DEVELOP", "DELIVER"].includes(target)) return { kind: "ok" }
			return { kind: "phase-changed", phase: target as DesignPhase }
		}
		case "skip":
			return { kind: "skip" }
		case "consistency": {
			const action = state.designedActions?.[0]
			const n = Number(parts[1] ?? "5")
			const intent = parts.slice(2).join(" ") || action?.testIntent || `use ${state.moduleName}`
			const r = await hooks.runConsistency(Number.isFinite(n) && n > 0 ? Math.floor(n) : 5, intent)
			void r
			return { kind: "consistency-result" }
		}
		default:
			return { kind: "ok" }
	}
}

/**
 * /skip advances through the phase machine. Each phase transitions to
 * the next without an LLM call. The DELIVER transition triggers
 * runDeliver which writes files and runs the consistency test.
 */
export function advanceOnSkip(state: DesignSessionState): DesignSessionState {
	switch (state.phase) {
		case "DISCOVER":
			return setPhase({ ...state, prefs: state.prefs ?? "" }, "DEFINE")
		case "DEFINE":
			return setPhase(state, "DEVELOP")
		case "DEVELOP":
			return setPhase(state, "DELIVER")
		case "DELIVER":
			return setPhase(state, "DONE")
		default:
			return state
	}
}

/** Extract the module name from the module directory path. */
export function stateModuleName(moduleDir: string): string {
	return moduleDir.split("/").filter(Boolean).pop() ?? "module"
}
