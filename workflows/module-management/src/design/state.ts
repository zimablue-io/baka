import type { LLMMessage } from "@repo/protocol"

// ---------------------------------------------------------------------------
// Design session state — the only place that knows the shape of the chat
// session. Pure: no I/O, no LLM, no console. All transitions are explicit
// functions that take the state and return a new state. This is what the
// workflow tests will exercise.
// ---------------------------------------------------------------------------

export type DesignPhase = "DISCOVER" | "DEFINE" | "DEVELOP" | "DELIVER" | "DONE"

export interface DesignedParam {
	name: string
	type: "string" | "number" | "boolean" | "enum"
	required: boolean
	description: string
	enumValues?: string[]
}

export interface DesignedValidator {
	id: string
	purpose: string
}

export interface DesignedTemplate {
	id: string
	outline: string
}

export interface DesignedAction {
	id: string
	description: string
	params: DesignedParam[]
	requiresReasoning: boolean
	compensatesWith: string | null
	validators: DesignedValidator[]
	templates?: DesignedTemplate[]
	testIntent: string
}

export interface RosterEntry {
	id: string
	description: string
	rationale: string
}

export interface DesignSessionState {
	moduleName: string
	brief: string
	phase: DesignPhase
	history: LLMMessage[]
	prefs?: string
	roster?: RosterEntry[]
	designedActions?: DesignedAction[]
	createdAt: string
	updatedAt: string
}

// ----- State factory + transitions ----------------------------------------

export function createInitialState(args: { moduleName: string; brief: string; now?: string }): DesignSessionState {
	const now = args.now ?? new Date().toISOString()
	return {
		moduleName: args.moduleName,
		brief: args.brief,
		phase: "DISCOVER",
		history: [],
		createdAt: now,
		updatedAt: now,
	}
}

export function touch(state: DesignSessionState, now?: string): DesignSessionState {
	return { ...state, updatedAt: now ?? new Date().toISOString() }
}

export function withHistory(state: DesignSessionState, message: LLMMessage): DesignSessionState {
	return { ...state, history: [...state.history, message] }
}

export function rewindLastTurn(state: DesignSessionState): DesignSessionState {
	if (state.history.length < 2) return state
	// Pop the assistant + user pair. The CLI maintains a 1:1 user/assistant
	// alternation; if the last item is an assistant, pop both.
	const next = state.history.slice(0, -2)
	return { ...state, history: next }
}

export function setPhase(state: DesignSessionState, phase: DesignPhase): DesignSessionState {
	return { ...state, phase }
}

// ----- Name validation ----------------------------------------------------

const NAME_PATTERN = /^[a-z0-9_.-]+$/
export function isValidModuleName(name: string): boolean {
	return name.length > 0 && name.length <= 64 && NAME_PATTERN.test(name)
}

export function invalidModuleNameMessage(): string {
	return "module name must be lowercase letters, digits, _ . or - (max 64 chars)"
}

// ----- Slash commands -----------------------------------------------------
//
// Slash commands are first-class at the workflow level. The CLI pipes its
// raw user input through `applySlashCommand` and gets back a result that
// tells it what to do next. The CLI does not need to know the list of
// commands — it just dispatches on the result.

export type SlashResult =
	| { kind: "ok"; message: string }
	| { kind: "noop" }
	| { kind: "exit" }
	| { kind: "rewound" }
	| { kind: "back"; phase: DesignPhase }
	| { kind: "skip" }
	| { kind: "consistency"; n: number; intent: string }
	| { kind: "show-prefs" }
	| { kind: "show-actions" }
	| { kind: "show-action"; id: string }
	| { kind: "help" }
	| { kind: "unknown"; cmd: string }

export function applySlashCommand(
	text: string,
	state: DesignSessionState,
	_hook: {
		runConsistency: (
			n: number,
			intent: string,
		) => Promise<{
			passed: boolean
			artifactDir: string
			divergences: string[]
			perRun: Array<{
				runIndex: number
				planActions: string[]
				planParams: Record<string, unknown>
				files: string[]
				fileHashes: Record<string, string>
				applyExitCode: number
				durationMs: number
			}>
		}>
	} = {
		runConsistency: async () => ({ passed: true, artifactDir: "", divergences: [], perRun: [] }),
	},
): SlashResult {
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
			return { kind: "ok", message: "saved" }
		case "show": {
			const what = parts[1]
			if (!what) return { kind: "ok", message: "usage: /show prefs|actions|<action-id>" }
			if (what === "prefs") return { kind: "show-prefs" }
			if (what === "actions") return { kind: "show-actions" }
			return { kind: "show-action", id: what }
		}
		case "rewind":
		case "undo": {
			if (state.history.length < 2) return { kind: "ok", message: "nothing to rewind" }
			return { kind: "rewound" }
		}
		case "back": {
			const target = (parts[1] ?? "").toUpperCase()
			if (!["DISCOVER", "DEFINE", "DEVELOP", "DELIVER"].includes(target)) {
				return { kind: "ok", message: "usage: /back <DISCOVER|DEFINE|DEVELOP|DELIVER>" }
			}
			return { kind: "back", phase: target as DesignPhase }
		}
		case "skip":
			return { kind: "skip" }
		case "consistency": {
			const action = state.designedActions?.[0]
			const n = Number(parts[1] ?? "5")
			const intent = parts.slice(2).join(" ") || action?.testIntent || `use ${state.moduleName}`
			return { kind: "consistency", n: Number.isFinite(n) && n > 0 ? Math.floor(n) : 5, intent }
		}
		case "validate":
			return { kind: "ok", message: "validate runs automatically during DELIVER" }
		case "help":
		case "?":
			return { kind: "help" }
		default:
			return { kind: "unknown", cmd }
	}
}
