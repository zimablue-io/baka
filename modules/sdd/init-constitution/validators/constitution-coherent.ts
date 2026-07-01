// ---------------------------------------------------------------------------
// sdd.init-constitution: constitutionCoherent
//
// A validator-role-LLM validator that runs after the init-constitution action.
// Two phases:
//
//   1. Pattern automations (deterministic TS):
//      - All three spec files (mission.md, tech-stack.md, roadmap.md) must
//        exist under <state.targetDirectory>/specs/.
//      - None of them may contain the placeholder body shipped by the
//        action when no renderedTemplates were provided.
//      - Each must carry its required H1 heading.
//   2. Validator-role LLM (semantic review):
//      - When all structural checks pass, the validator asks the
//        validator-role LLM whether the three documents together
//        describe a coherent product. The validator returns
//        { coherent: boolean, issues: string[] }. Each issue becomes one
//        warning diagnostic. A coherent:true verdict emits no
//        diagnostics.
//
// The validator hard-fails (via loadLLMConfig) when the validator role is
// not configured. It must NEVER silently fall back to the worker role.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState, ValidationDiagnostic } from "baka-sdk"
import { callLLMAsValidator } from "baka-sdk"
import { z } from "zod"

const RULE_ID = "sdd.init-constitution:constitutionCoherent"

const SPEC_FILES = ["mission.md", "tech-stack.md", "roadmap.md"] as const
type SpecFile = (typeof SPEC_FILES)[number]

// Substrings that indicate the action's placeholder body was written
// instead of real content. The action emits these verbatim when
// `renderedTemplates` is missing for a file; the validator flags them so
// the user knows the LLM didn't actually produce content for that file.
// Matched by shape, not literal text, so the validator source never
// embeds the action's emitted marker.
const STUB_MARKERS: Record<SpecFile, RegExp> = {
	"mission.md": /^_[A-Z]{2,}_$/m,
	"tech-stack.md": /\(not yet decided\)/,
	"roadmap.md": /- TBD/,
}

const HEADING_REQUIRED: Record<SpecFile, RegExp> = {
	"mission.md": /^#\s+.*Mission/m,
	"tech-stack.md": /^#\s+.*Tech Stack/m,
	"roadmap.md": /^#\s+.*Roadmap/m,
}

const VALIDATOR_RESPONSE_SCHEMA = z.object({
	coherent: z.boolean(),
	issues: z.array(z.string()),
})

const VALIDATOR_SYSTEM_PROMPT =
	"You are an editor reviewing a small product constitution (mission, tech stack, roadmap). " +
	"Determine whether the three documents together describe a coherent, plausible product. " +
	"Respond with a JSON object: `{ coherent: boolean, issues: string[] }`. " +
	"`coherent: true` only if the documents are specific, internally consistent, and non-contradictory. " +
	"Otherwise `coherent: false` and list each concrete issue in `issues[]`."

function filePath(state: OrchestrationState, name: SpecFile): string {
	return join(state.targetDirectory, "specs", name)
}

function readSpecFile(state: OrchestrationState, name: SpecFile): string | undefined {
	const path = filePath(state, name)
	return existsSync(path) ? readFileSync(path, "utf-8") : undefined
}

export const constitutionCoherent = async (state: OrchestrationState): Promise<ValidationDiagnostic[]> => {
	const diagnostics: ValidationDiagnostic[] = []
	const contents: Record<SpecFile, string | undefined> = {
		"mission.md": undefined,
		"tech-stack.md": undefined,
		"roadmap.md": undefined,
	}

	for (const name of SPEC_FILES) {
		const body = readSpecFile(state, name)
		if (!body) {
			diagnostics.push({
				severity: "error",
				rule: RULE_ID,
				message: `missing spec file: specs/${name}. Run \`baka plan\` for sdd:init-constitution to write it.`,
				file: filePath(state, name),
			})
			continue
		}
		if (STUB_MARKERS[name].test(body)) {
			diagnostics.push({
				severity: "error",
				rule: RULE_ID,
				message: `specs/${name} is the action's fallback stub (no renderedTemplates were provided). Re-run \`baka plan\` for sdd:init-constitution with a working LLM.`,
				file: filePath(state, name),
			})
		}
		if (!HEADING_REQUIRED[name].test(body)) {
			diagnostics.push({
				severity: "error",
				rule: RULE_ID,
				message: `specs/${name} is missing its required heading (expected pattern ${HEADING_REQUIRED[name].source}).`,
				file: filePath(state, name),
			})
		}
		contents[name] = body
	}

	// Don't bother the LLM if any structural check failed — the error
	// diagnostics already explain what to fix.
	const structuralFailures = diagnostics.filter((d) => d.severity === "error")
	if (structuralFailures.length > 0) {
		return diagnostics
	}

	const prompt = [
		"Here is a product constitution. Decide whether it is coherent.",
		"",
		"--- specs/mission.md ---",
		contents["mission.md"],
		"",
		"--- specs/tech-stack.md ---",
		contents["tech-stack.md"],
		"",
		"--- specs/roadmap.md ---",
		contents["roadmap.md"],
		"",
		"Issues to consider: vague or vacuous phrasing, contradictory commitments across the three documents, " +
			"missing specificity on the target user, technology choices that don't fit the mission, or a roadmap " +
			"that ignores the tech stack's constraints.",
	].join("\n")

	let verdict: { coherent: boolean; issues: string[] }
	try {
		verdict = await callLLMAsValidator<{ coherent: boolean; issues: string[] }>({
			cwd: state.targetDirectory,
			system: VALIDATOR_SYSTEM_PROMPT,
			prompt,
			responseSchema: VALIDATOR_RESPONSE_SCHEMA,
		})
	} catch (err) {
		// The validator role is required: a missing or incomplete role
		// config is a user error and must surface as a throw so the
		// validator pipeline fails fast (matching the user's "hard
		// fail" contract). Any other LLM-call failure (unreachable
		// model, schema rejection, transport error) is a transient
		// condition the validator absorbs as a warning — the structural
		// checks already passed; the validator's job is to surface
		// "could not reach the validator-role LLM" without crashing
		// the whole validate pass.
		const message = err instanceof Error ? err.message : String(err)
		if (/validator role not configured|missing LLM config/.test(message)) {
			throw err
		}
		diagnostics.push({
			severity: "warning",
			rule: RULE_ID,
			message: `constitution review skipped (validator-role LLM unavailable): ${message}`,
		})
		return diagnostics
	}

	if (verdict.coherent) return diagnostics

	for (const issue of verdict.issues) {
		diagnostics.push({
			severity: "warning",
			rule: RULE_ID,
			message: `constitution review: ${issue}`,
		})
	}
	return diagnostics
}
