// ---------------------------------------------------------------------------
// Prompt functions. Thin wrappers that combine render (state → string)
// + inquirer/input (the user's keyboard) + parse (string → decision).
// These are the hooks the workflow calls when it needs the user's
// attention. The actual I/O is delegated to injected dependencies, so
// the prompts can be unit-tested by swapping `input` for a mock.
// ---------------------------------------------------------------------------

import { input as inquirerInput } from "@inquirer/prompts"
import type { DesignSessionState } from "@repo/module-management-workflow"
import { getDefaultE2EInputSource, isE2EMode, type E2EInputSource } from "./e2e-input"
import {
	parseDefineApproval,
	parseDeliverApproval,
	parseDevelopApproval,
	type DefineApproval,
	type DeliverApproval,
	type DevelopApproval,
} from "./parse"
import {
	renderDefineApprovalQuestion,
	renderDeliverApprovalQuestion,
	renderDevelopApprovalQuestion,
	renderFirstPromptContext,
} from "./render"

/** Minimal inquirer-compatible input function (swappable in tests). */
export type InputFn = (opts: { message: string; validate?: (v: string) => true | string }) => Promise<string>

/** Dependencies a prompt function needs. All swappable in tests. */
export interface PromptDeps {
	input: InputFn
	e2eSource: E2EInputSource
	shouldShowHelp: () => boolean
	markHelpShown: () => void
}

const defaultDeps: PromptDeps = {
	input: inquirerInput as InputFn,
	e2eSource: getDefaultE2EInputSource(),
	shouldShowHelp: () => false,
	markHelpShown: () => {},
}

let helpShownThisSession = false
function shouldShowHelpDefault(): boolean {
	return !helpShownThisSession
}
function markHelpShownDefault(): void {
	helpShownThisSession = true
}

/** Reset the process-scoped "help was shown" flag (for tests). */
export function resetHelpShown(): void {
	helpShownThisSession = false
}

function buildDefaultDeps(): PromptDeps {
	return {
		input: inquirerInput as InputFn,
		e2eSource: getDefaultE2EInputSource(),
		shouldShowHelp: shouldShowHelpDefault,
		markHelpShown: markHelpShownDefault,
	}
}

export async function promptUser(
	state: DesignSessionState,
	deps: PromptDeps = buildDefaultDeps(),
): Promise<string | null> {
	const showHelp = deps.shouldShowHelp()
	console.log(renderFirstPromptContext(state, { showHelp }))
	if (showHelp) deps.markHelpShown()
	if (isE2EMode()) {
		const text = deps.e2eSource.next()
		if (text === null) return null
		console.log(`> ${text}`)
		return text
	}
	try {
		const text = await deps.input({
			message: `> `,
			validate: (v) => (v.trim() === "" ? "type something, or /exit" : true),
		})
		return text
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (message.includes("force closed") || message.includes("ExitPromptError")) return null
		throw err
	}
}

export async function promptDefineApproval(
	state: DesignSessionState,
	resume: (decision: DefineApproval) => void,
	deps: PromptDeps = buildDefaultDeps(),
): Promise<void> {
	console.log(renderDefineApprovalQuestion(state))
	const question = "approve the roster? (yes / no <reason>)"
	const answer = await readAnswer(question, "type yes or no <reason>", deps)
	resume(parseDefineApproval(answer))
}

export async function promptDevelopApproval(
	state: DesignSessionState,
	resume: (decision: DevelopApproval) => void,
	deps: PromptDeps = buildDefaultDeps(),
): Promise<void> {
	console.log(renderDevelopApprovalQuestion(state))
	const question = "approve the design? (yes / edit <text>)"
	const answer = await readAnswer(question, "type yes or edit <text>", deps)
	resume(parseDevelopApproval(answer))
}

export async function promptDeliverApproval(
	_state: DesignSessionState,
	resume: (decision: DeliverApproval) => void,
	deps: PromptDeps = buildDefaultDeps(),
): Promise<void> {
	console.log(renderDeliverApprovalQuestion())
	const question = "proceed? (yes / no)"
	const answer = await readAnswer(question, "type yes or no", deps)
	resume(parseDeliverApproval(answer))
}

async function readAnswer(question: string, emptyHint: string, deps: PromptDeps): Promise<string | null> {
	if (isE2EMode()) {
		console.log(`[prompt: ${question}]`)
		const text = deps.e2eSource.next()
		if (text === null) return null
		console.log(`> ${text}`)
		return text
	}
	return await deps.input({
		message: question,
		validate: (v) => (v.trim() === "" ? emptyHint : true),
	})
}
