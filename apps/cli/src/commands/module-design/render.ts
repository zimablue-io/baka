// ---------------------------------------------------------------------------
// Pure rendering functions. State/string in, string out. No I/O, no
// side effects. These are the building blocks the prompt functions
// compose to produce what the user sees.
// ---------------------------------------------------------------------------

import type { DesignSessionState, DesignTurnPayload } from "@repo/module-management-workflow"

export const SLASH_HELP = `[commands]
  /exit         quit the session (state is saved; resume with \`baka module create <name>\`)
  /save         persist the current state
  /show prefs   show the PREFERENCES.md draft
  /show actions show the proposed action roster
  /show <id>    show details of an action
  /rewind       pop the last user/assistant pair
  /back <p>     jump to phase p (DISCOVER|DEFINE|DEVELOP|DELIVER)
  /skip         advance to the next phase (skips the LLM)
  /consistency [n] [intent]  run the 5x consistency test on the first action
  /help         show this help`

export function renderBriefEcho(brief: string): string {
	return `[brief: ${brief}]`
}

export function renderPhaseHeader(phase: string): string {
	return `[phase: ${phase}]`
}

/**
 * What to print immediately above the first `> ` prompt of the session.
 * Includes the phase, a one-line brief echo, and (on the very first
 * prompt) the slash command help block. This is what makes the REPL
 * feel like a guided conversation instead of a bare prompt.
 */
export function renderFirstPromptContext(state: DesignSessionState, options: { showHelp: boolean }): string {
	const parts: string[] = [""]
	parts.push(renderPhaseHeader(state.phase))
	if (state.brief && !state.brief.startsWith("__brief_")) {
		const truncated = state.brief.length > 100 ? `${state.brief.slice(0, 100)}...` : state.brief
		parts.push(renderBriefEcho(truncated))
	}
	if (options.showHelp) {
		parts.push(SLASH_HELP)
	}
	return parts.join("\n")
}

export function renderResumeContext(state: DesignSessionState): string {
	const last = state.history[state.history.length - 1]
	if (last && last.role === "assistant") {
		return `\n[last assistant message]\n${last.content}\n`
	}
	return ""
}

/** Render the LLM's payload to the console. Pure: state → string. */
export function renderPayload(payload: DesignTurnPayload, _state: DesignSessionState): string {
	const parts: string[] = [`\n${payload.message}\n`]
	switch (payload.phase) {
		case "DISCOVER":
			if (payload.questions.length > 0) {
				parts.push(`Questions:`)
				for (const q of payload.questions) {
					parts.push(`  [${q.id}] ${q.prompt}`)
					parts.push(`        why: ${q.whyWeNeedThis}`)
				}
				parts.push(``)
			}
			if (payload.finished && payload.synthesizedPrefs) {
				parts.push(`[LLM has synthesized PREFERENCES.md]`)
			}
			break
		case "DEFINE":
			if (payload.actions.length > 0) {
				parts.push(`Proposed actions:`)
				for (const a of payload.actions) {
					parts.push(`  - ${a.id}: ${a.description}`)
					parts.push(`        ${a.rationale}`)
				}
				parts.push(``)
			}
			break
		case "DEVELOP":
			if (payload.actions.length > 0) {
				for (const a of payload.actions) {
					parts.push(`  ${a.id}:`)
					parts.push(`    params: ${a.params.length}`)
					for (const p of a.params) {
						const req = p.required ? "required" : "optional"
						const enumHint = p.enumValues ? ` [${p.enumValues.join("|")}]` : ""
						parts.push(`      - ${p.name} (${p.type}${enumHint}, ${req}): ${p.description}`)
					}
					parts.push(`    requiresReasoning: ${a.requiresReasoning}`)
					parts.push(`    compensatesWith: ${a.compensatesWith ?? "(none)"}`)
					parts.push(`    validators: ${a.validators.map((v) => v.id).join(", ")}`)
					if (a.templates && a.templates.length > 0) {
						parts.push(`    templates: ${a.templates.map((t) => t.id).join(", ")}`)
					}
					parts.push(`    testIntent: "${a.testIntent}"`)
				}
				parts.push(``)
			}
			break
		case "DELIVER":
			parts.push(`[${payload.message}]`)
			break
	}
	return parts.join("\n")
}

export function renderDefineApprovalQuestion(state: DesignSessionState): string {
	const parts: string[] = [`\n[DEFINE] LLM proposed action roster:`]
	for (const a of state.roster ?? []) {
		parts.push(`  - ${a.id}: ${a.description}`)
		parts.push(`        ${a.rationale}`)
	}
	parts.push(``)
	return parts.join("\n")
}

export function renderDevelopApprovalQuestion(state: DesignSessionState): string {
	const parts: string[] = [`\n[DEVELOP] Designed action(s):`]
	for (const a of state.designedActions ?? []) {
		parts.push(`  ${a.id}: ${a.description}`)
		parts.push(
			`    params: ${a.params.length}, validators: ${a.validators.length}, requiresReasoning=${a.requiresReasoning}`,
		)
		parts.push(`    testIntent: "${a.testIntent}"`)
	}
	parts.push(``)
	return parts.join("\n")
}

export function renderDeliverApprovalQuestion(): string {
	return `\n[DELIVER] ready to write files and run the 5x consistency test.\n`
}

export function renderConsistencyResult(result: {
	passed: boolean
	n: number
	moduleName: string
	actionId: string
	artifactDir: string
	perRun: Array<{ runIndex: number; planActions: unknown[]; files: unknown[]; applyExitCode: number }>
	divergences: string[]
}): string {
	const parts: string[] = [
		`\n[consistency: ${result.passed ? "PASS" : "FAIL"} — ${result.n} run(s) for ${result.moduleName}:${result.actionId}]`,
	]
	for (const r of result.perRun) {
		parts.push(
			`  run ${r.runIndex}: ${r.planActions.length} plan step(s), ${r.files.length} file(s), apply exit ${r.applyExitCode}`,
		)
	}
	if (result.divergences.length > 0) {
		parts.push(`  divergences:`)
		for (const d of result.divergences.slice(0, 10)) parts.push(`    - ${d}`)
		if (result.divergences.length > 10) parts.push(`    ... (${result.divergences.length - 10} more)`)
	}
	parts.push(`  trace: ${result.artifactDir}`)
	return parts.join("\n")
}
