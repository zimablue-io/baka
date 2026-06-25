import type { LLMProvider } from "@repo/protocol"
import {
	type DeliverOutcome,
	defineApprovalHook,
	deliverApprovalHook,
	developApprovalHook,
	pauseForApproval,
	runDeliverIfApproved,
} from "./approval.js"
import { runLLMTurn } from "./llm.js"
import type { DesignTurnPayload } from "./payload.js"
import { applyPayload } from "./payload-apply.js"
import { loadSession } from "./session.js"
import { advanceOnSkip, handleSlashInLoop, stateModuleName } from "./slash.js"
import { createInitialState, type DesignSessionState, rewindLastTurn, setPhase, withHistory } from "./state.js"

// ---------------------------------------------------------------------------
// The chat orchestrator. Hooks drive every consequential pause point.
//
// This is the workflow-sdk HITL pattern from
// https://workflow-sdk.dev/cookbook/agent-patterns/human-in-the-loop —
// modeled in-process for a CLI:
//
//   1. onUserInput — the chat REPL's primary input. The CLI returns the
//      user's text; the loop feeds it to the LLM.
//   2. onDefineApproval — fires when the LLM proposes a final action
//      roster in DEFINE (payload.finished === true). On rejection, the
//      rejection note is fed back to the LLM in the next turn.
//   3. onDevelopApproval — fires per designed action in DEVELOP.
//   4. onDeliverApproval — fires when the workflow is about to write
//      files and run the 5x consistency test. Rejection rolls back to
//      DEVELOP.
//
// The CLI provides the inquirer input loop + console rendering. The
// workflow owns the state machine, the LLM turn driver, the hook
// creation, the slash command fast path, and the file writing.
// ---------------------------------------------------------------------------

export interface ChatLoopHooks {
	onAssistantMessage: (payload: DesignTurnPayload, state: DesignSessionState) => void
	onUserInput: (state: DesignSessionState) => Promise<string | null>
	onDefineApproval?: (
		state: DesignSessionState,
		resume: (decision: { approved: boolean; note?: string }) => void,
	) => void
	onDevelopApproval?: (
		state: DesignSessionState,
		resume: (decision: { approved: boolean; edits?: string }) => void,
	) => void
	onDeliverApproval?: (state: DesignSessionState, resume: (decision: { approved: boolean }) => void) => void
	/**
	 * Called when the bootstrap LLM call (the one that injects the brief
	 * as a synthetic first user message) fails. The CLI uses this to
	 * print a clear error to the user instead of leaving them staring at
	 * a silent prompt.
	 */
	onBootstrapFailed?: (error: string) => void
	onStateChanged?: (state: DesignSessionState) => void
	runConsistency: (n: number, intent: string) => Promise<{ passed: boolean; artifactDir: string; summary: string }>
}

export interface ChatLoopOptions {
	provider: LLMProvider
	moduleDir: string
	hooks: ChatLoopHooks
	brief?: string
	maxTurns?: number
}

export interface ChatLoopResult {
	finalState: DesignSessionState
	turns: number
	exited: "done" | "user-exit" | "max-turns" | "consistency-failure" | "rejected"
}

export async function runChatLoop(opts: ChatLoopOptions): Promise<ChatLoopResult> {
	const { provider, moduleDir, hooks } = opts
	const maxTurns = opts.maxTurns ?? 100
	let state = loadSession(moduleDir)
	if (!state) {
		const brief = opts.brief ?? ""
		state = createInitialState({ moduleName: stateModuleName(moduleDir), brief })
		hooks.onStateChanged?.(state)
	}

	defineApprovalHook._clear()
	developApprovalHook._clear()
	deliverApprovalHook._clear()

	// Bootstrap: on a fresh session with a brief, kick off the LLM
	// conversation by injecting the brief as the first user message and
	// calling the LLM. The user sees the LLM's first response BEFORE
	// being asked for input. This is the "the LLM drives the loop" model
	// the workflow-sdk cookbook recommends, not "the user types into a
	// void".
	//
	// If the bootstrap LLM call fails (network down, model error, etc.)
	// we silently fall through to the main loop. The user's first typed
	// input is then used as a fresh prompt — the synthetic brief is
	// popped from history so the next LLM call doesn't see a stale user
	// message.
	if (state.history.length === 0 && state.brief) {
		const bootstrapped = await runBootstrapTurn({ state, provider, hooks })
		state = bootstrapped.state
	}

	let turns = 0
	let exited: ChatLoopResult["exited"] = "user-exit"

	while (state.phase !== "DONE" && turns < maxTurns) {
		turns++
		const exit = await runOneTurn({ state, turns, provider, moduleDir, hooks })
		state = exit.state
		if (exit.broke) {
			exited = exit.exited
			break
		}
	}

	if (turns >= maxTurns && state.phase !== "DONE") exited = "max-turns"
	return { finalState: state, turns, exited }
}

// ----- Bootstrap turn -----------------------------------------------------
//
// On a fresh session (no history, has a brief), drive the LLM once with
// the brief as a synthetic first user message. This makes the REPL feel
// like a real chat: the user types the brief, the LLM responds with
// clarifying questions, THEN the user is prompted for their first
// answer. Without this, the user would see a bare `> ` with no context.

interface BootstrapResult {
	state: DesignSessionState
	failed: boolean
}

async function runBootstrapTurn(args: {
	state: DesignSessionState
	provider: LLMProvider
	hooks: ChatLoopHooks
}): Promise<BootstrapResult> {
	let state = withHistory(args.state, { role: "user", content: args.state.brief })
	args.hooks.onStateChanged?.(state)
	const llm = await runLLMTurn({ provider: args.provider, state })
	if (!llm.ok || !llm.payload || !llm.updatedHistory) {
		// The LLM is unreachable or returned an invalid payload. Pop the
		// synthetic user message so the session stays clean and let the
		// CLI surface the error.
		state = { ...state, history: state.history.slice(0, -1) }
		args.hooks.onStateChanged?.(state)
		args.hooks.onBootstrapFailed?.(llm.error ?? "no payload")
		return { state, failed: true }
	}
	state = { ...state, history: llm.updatedHistory }
	args.hooks.onAssistantMessage(llm.payload, state)
	const { state: next } = applyPayload(state, llm.payload)
	state = next
	args.hooks.onStateChanged?.(state)
	return { state, failed: false }
}

// ----- One turn of the loop ----------------------------------------------

interface OneTurnResult {
	state: DesignSessionState
	broke: boolean
	exited: ChatLoopResult["exited"]
}

async function runOneTurn(args: {
	state: DesignSessionState
	turns: number
	provider: LLMProvider
	moduleDir: string
	hooks: ChatLoopHooks
}): Promise<OneTurnResult> {
	const { turns, provider, moduleDir, hooks } = args
	let state = args.state

	const userText = await hooks.onUserInput(state)
	if (userText === null) {
		return { state, broke: true, exited: "user-exit" }
	}
	const trimmed = userText.trim()
	if (trimmed === "") return { state, broke: false, exited: "user-exit" }

	// Slash command fast path
	if (trimmed.startsWith("/")) {
		const slash = await handleSlashInLoop(trimmed, state, hooks)
		if (slash.kind === "exit") return { state, broke: true, exited: "user-exit" }
		if (slash.kind === "rewound") {
			state = rewindLastTurn(state)
			hooks.onStateChanged?.(state)
			return { state, broke: false, exited: "user-exit" }
		}
		if (slash.kind === "phase-changed") {
			state = setPhase(state, slash.phase)
			hooks.onStateChanged?.(state)
			return { state, broke: false, exited: "user-exit" }
		}
		if (slash.kind === "skip") {
			state = advanceOnSkip(state)
			hooks.onStateChanged?.(state)
			if (state.phase === "DELIVER") {
				const d = await runDeliverIfApproved({
					state,
					moduleDir,
					onDeliverApproval: hooks.onDeliverApproval,
					runConsistency: hooks.runConsistency,
				})
				if (d.outcome === "done" || d.outcome === "no-actions") {
					state = setPhase(state, "DONE")
					hooks.onStateChanged?.(state)
					return { state, broke: true, exited: "done" }
				}
				if (d.outcome === "consistency-failure") {
					state = setPhase(state, "DEVELOP")
					hooks.onStateChanged?.(state)
					return { state, broke: true, exited: "consistency-failure" }
				}
				if (d.outcome === "rejected") {
					state = setPhase(state, "DEVELOP")
					hooks.onStateChanged?.(state)
					return { state, broke: true, exited: "rejected" }
				}
			}
			return { state, broke: false, exited: "user-exit" }
		}
		// ok, noop, consistency-result, help: no state change
		return { state, broke: false, exited: "user-exit" }
	}

	// Regular turn: append user text, call LLM
	state = withHistory(state, { role: "user", content: userText })
	hooks.onStateChanged?.(state)
	const llm = await runLLMTurn({ provider, state })
	if (!llm.ok || !llm.payload || !llm.updatedHistory) {
		// Pop the user message so the next turn can retry the same prompt.
		state = { ...state, history: state.history.slice(0, -1) }
		hooks.onStateChanged?.(state)
		return { state, broke: false, exited: "user-exit" }
	}
	state = { ...state, history: llm.updatedHistory }
	hooks.onAssistantMessage(llm.payload, state)

	const { state: next, result } = applyPayload(state, llm.payload)
	state = next
	if (result.phaseChanged) hooks.onStateChanged?.(state)

	// ---- Phase-specific approval gates ----
	const justFinished = llm.payload.finished === true

	if (
		justFinished &&
		llm.payload.phase === "DEFINE" &&
		state.phase === "DEVELOP" &&
		state.roster &&
		state.roster.length > 0
	) {
		const approval = await pauseForApproval<{ approved: boolean; note?: string }>({
			hookCallback: hooks.onDefineApproval,
			state,
			token: `define-${turns}`,
			hook: defineApprovalHook,
			autoApprove: (s) => ({ approved: true, note: "auto-approved" }),
		})
		if (!approval.approved) {
			state = setPhase(state, "DEFINE")
			state = withHistory(state, {
				role: "user",
				content: `Roster rejected${approval.note ? `: ${approval.note}` : ""}. Please re-think.`,
			})
			hooks.onStateChanged?.(state)
			return { state, broke: false, exited: "user-exit" }
		}
		state = withHistory(state, {
			role: "user",
			content: `Roster approved${approval.note ? `: ${approval.note}` : ""}.`,
		})
		hooks.onStateChanged?.(state)
		return { state, broke: false, exited: "user-exit" }
	}

	if (
		justFinished &&
		llm.payload.phase === "DEVELOP" &&
		state.phase === "DELIVER" &&
		state.designedActions &&
		state.designedActions.length > 0
	) {
		const approval = await pauseForApproval<{ approved: boolean; edits?: string }>({
			hookCallback: hooks.onDevelopApproval,
			state,
			token: `develop-${turns}`,
			hook: developApprovalHook,
			autoApprove: () => ({ approved: true }),
		})
		if (!approval.approved) {
			state = setPhase(state, "DEVELOP")
			state = withHistory(state, {
				role: "user",
				content: `Design rejected${approval.edits ? `: ${approval.edits}` : ""}. Please re-think.`,
			})
			hooks.onStateChanged?.(state)
			return { state, broke: false, exited: "user-exit" }
		}
		state = withHistory(state, {
			role: "user",
			content: `Design approved${approval.edits ? `: ${approval.edits}` : ""}.`,
		})
		hooks.onStateChanged?.(state)
		// Fall through to the DELIVER gate below.
	}

	if (state.phase === "DELIVER") {
		const d = await runDeliverIfApproved({
			state,
			moduleDir,
			onDeliverApproval: hooks.onDeliverApproval,
			runConsistency: hooks.runConsistency,
		})
		if (d.outcome === "done" || d.outcome === "no-actions") {
			state = setPhase(state, "DONE")
			hooks.onStateChanged?.(state)
			return { state, broke: true, exited: "done" }
		}
		if (d.outcome === "consistency-failure") {
			state = setPhase(state, "DEVELOP")
			hooks.onStateChanged?.(state)
			return { state, broke: true, exited: "consistency-failure" }
		}
		if (d.outcome === "rejected") {
			state = setPhase(state, "DEVELOP")
			hooks.onStateChanged?.(state)
			return { state, broke: true, exited: "rejected" }
		}
	}

	return { state, broke: false, exited: "user-exit" }
}

export type { DeliverOutcome, RunDeliverArgs, RunDeliverResult } from "./approval"
export { defineApprovalHook, deliverApprovalHook, developApprovalHook, runDeliver } from "./approval"
export type { RunLLMTurnArgs, RunLLMTurnResult } from "./llm"
export { runLLMTurn } from "./llm"
export type { ApplyPayloadResult } from "./payload-apply"
export { applyPayload } from "./payload-apply"
export { applyBack } from "./phase-utils"
// Re-exports so consumers can still import everything from "./chat"
export { loadSession, STATE_FILE, saveSession } from "./session"
