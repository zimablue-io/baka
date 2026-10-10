import { defineApprovalHook, deliverApprovalHook, developApprovalHook } from "./hooks"
import { writePackFiles } from "./render"
import type { DesignSessionState } from "./state"

// ---------------------------------------------------------------------------
// HITL approval gates.
//
// This is the workflow-sdk cookbook's "defineHook + await + resume" pattern
// (https://workflow-sdk.dev/cookbook/agent-patterns/human-in-the-loop),
// modeled in-process for a CLI:
//
//   const defHook = defineApprovalHook.create({ token: "define-3" })
//   hooks.onDefineApproval(state, (decision) => {
//     defineApprovalHook.resume("define-3", decision)
//   })
//   const approval = await defHook
//
// The CLI's onDefineApproval / onDevelopApproval / onDeliverApproval
// callbacks display the question, prompt the user, and call resume. The
// workflow's runChatLoop awaits the returned promise.
//
// pauseForApproval() auto-approves when the hookCallback is undefined
// (useful in tests).
// ---------------------------------------------------------------------------

type DeliverOutcome = "done" | "consistency-failure" | "rejected" | "no-recipes"

interface PauseForApprovalArgs<TDecision> {
	hookCallback: ((state: DesignSessionState, resume: (decision: TDecision) => void) => void) | undefined
	state: DesignSessionState
	token: string
	hook: {
		create: (opts: { token: string }) => Promise<TDecision> & { token: string }
		resume: (token: string, payload: TDecision) => void
	}
	autoApprove: (state: DesignSessionState) => TDecision
}

export async function pauseForApproval<TDecision>(args: PauseForApprovalArgs<TDecision>): Promise<TDecision> {
	if (!args.hookCallback) {
		return args.autoApprove(args.state)
	}
	const promise = args.hook.create({ token: args.token })
	args.hookCallback(args.state, (decision) => {
		const t = (promise as unknown as { token: string }).token
		args.hook.resume(t, decision)
	})
	return await promise
}

// ----- DELIVER runner ----------------------------------------------------

export interface RunDeliverArgs {
	state: DesignSessionState
	packDir: string
	runConsistency: (n: number, intent: string) => Promise<{ passed: boolean; artifactDir: string; summary: string }>
}

export interface RunDeliverResult {
	outcome: "done" | "consistency-failure" | "no-recipes"
	writtenFiles: string[]
}

export async function runDeliver({ state, packDir, runConsistency }: RunDeliverArgs): Promise<RunDeliverResult> {
	const written = writePackFiles({ packDir, packName: state.packName, state })
	const recipe = state.designedRecipes?.[0]
	if (!recipe) {
		return { outcome: "no-recipes", writtenFiles: written.writtenFiles }
	}
	const r = await runConsistency(5, recipe.testIntent)
	if (!r.passed) {
		return { outcome: "consistency-failure", writtenFiles: written.writtenFiles }
	}
	return { outcome: "done", writtenFiles: written.writtenFiles }
}

// ----- DELIVER runner with approval gate ---------------------------------

interface RunDeliverWithHookResult {
	outcome: DeliverOutcome
	writtenFiles: string[]
}

type DeliverApprovalCallback = (state: DesignSessionState, resume: (decision: { approved: boolean }) => void) => void

export async function runDeliverIfApproved(args: {
	state: DesignSessionState
	packDir: string
	onDeliverApproval: DeliverApprovalCallback | undefined
	runConsistency: (n: number, intent: string) => Promise<{ passed: boolean; artifactDir: string; summary: string }>
}): Promise<RunDeliverWithHookResult> {
	const approval = await pauseForApproval<{ approved: boolean }>({
		hookCallback: args.onDeliverApproval,
		state: args.state,
		token: `deliver-${args.state.history.length}`,
		hook: deliverApprovalHook,
		autoApprove: () => ({ approved: true }),
	})
	if (!approval.approved) {
		return { outcome: "rejected", writtenFiles: [] }
	}
	const d = await runDeliver({
		state: args.state,
		packDir: args.packDir,
		runConsistency: args.runConsistency,
	})
	return { outcome: d.outcome, writtenFiles: d.writtenFiles }
}

// ----- Re-exports so callers can do `import { defineApprovalHook } from "..."` ----

export { defineApprovalHook, deliverApprovalHook, developApprovalHook }
