// ---------------------------------------------------------------------------
// sdd.create-feature: featureSpecCoherent
//
// A validator-role-LLM validator that runs after the create-feature action.
// Iterates over every `specs/YYYY-MM-DD-<name>/` folder under the target
// directory and applies the same two-phase check as constitutionCoherent:
//
//   1. Pattern automations: each folder must contain plan.md,
//      requirements.md, validation.md. Each must carry its required H1.
//   2. Validator-role LLM (semantic review): for each folder whose
//      structural checks pass, the validator asks the validator-role LLM
//      whether the three documents together describe a coherent feature
//      spec.
//
// The validator hard-fails (via loadLLMConfig) when the validator role is
// not configured. It must NEVER silently fall back to the worker role.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState, ValidationDiagnostic } from "baka-sdk"
import { callLLMAsValidator } from "baka-sdk"
import { z } from "zod"

const SPECS_DIR = "specs"
const SPEC_FILES = ["plan.md", "requirements.md", "validation.md"] as const
type SpecFile = (typeof SPEC_FILES)[number]

// The action writes an unrendered body when no LLM call succeeded. We
// detect it via the placeholder shape rather than the literal text so
// the source never embeds the action's emitted marker.
const PLACEHOLDER_PATTERN: RegExp = /^_[A-Z]{2,}_$/m

const HEADING_REQUIRED: Record<SpecFile, RegExp> = {
	"plan.md": /^#\s+.*Plan/m,
	"requirements.md": /^#\s+.*Requirements/m,
	"validation.md": /^#\s+.*Validation/m,
}

const VALIDATOR_RESPONSE_SCHEMA = z.object({
	coherent: z.boolean(),
	issues: z.array(z.string()),
})

const VALIDATOR_SYSTEM_PROMPT =
	"You are an editor reviewing a small feature spec (plan, requirements, validation). " +
	"Determine whether the three documents together describe a coherent, implementable feature. " +
	"Respond with a JSON object: `{ coherent: boolean, issues: string[] }`. " +
	"`coherent: true` only if the plan is concrete, the requirements are unambiguous, and the validation " +
	"criteria are measurable. Otherwise `coherent: false` and list each concrete issue in `issues[]`."

function specFolderPath(state: OrchestrationState, folder: string): string {
	return join(state.targetDirectory, SPECS_DIR, folder)
}

function filePath(state: OrchestrationState, folder: string, name: SpecFile): string {
	return join(specFolderPath(state, folder), name)
}

function readSpecFile(state: OrchestrationState, folder: string, name: SpecFile): string | undefined {
	const path = filePath(state, folder, name)
	return existsSync(path) ? readFileSync(path, "utf-8") : undefined
}

/** Returns the kebab-case feature name suffix of a date-prefixed folder, or null. */
function featureNameOf(folder: string): string | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/.exec(folder)
	return m ? (m[4] ?? null) : null
}

async function reviewFolder(state: OrchestrationState, folder: string): Promise<ValidationDiagnostic[]> {
	const rule = "sdd.create-feature:featureSpecCoherent"
	const diagnostics: ValidationDiagnostic[] = []
	const contents: Record<SpecFile, string | undefined> = {
		"plan.md": undefined,
		"requirements.md": undefined,
		"validation.md": undefined,
	}

	for (const name of SPEC_FILES) {
		const body = readSpecFile(state, folder, name)
		if (!body) {
			diagnostics.push({
				severity: "error",
				rule,
				message: `missing spec file: ${SPECS_DIR}/${folder}/${name}. Re-run \`baka plan\` for sdd:create-feature to write it.`,
				file: filePath(state, folder, name),
			})
			continue
		}
		if (PLACEHOLDER_PATTERN.test(body)) {
			diagnostics.push({
				severity: "error",
				rule,
				message: `${SPECS_DIR}/${folder}/${name} is the action's placeholder body (no renderedTemplates were provided). Re-run with a working LLM.`,
				file: filePath(state, folder, name),
			})
		}
		if (!HEADING_REQUIRED[name].test(body)) {
			diagnostics.push({
				severity: "error",
				rule,
				message: `${SPECS_DIR}/${folder}/${name} is missing its required heading (expected pattern ${HEADING_REQUIRED[name].source}).`,
				file: filePath(state, folder, name),
			})
		}
		contents[name] = body
	}

	if (diagnostics.some((d) => d.severity === "error")) return diagnostics

	const featureName = featureNameOf(folder) ?? folder
	const prompt = [
		`Feature: ${featureName}`,
		"",
		`--- ${SPECS_DIR}/${folder}/plan.md ---`,
		contents["plan.md"],
		"",
		`--- ${SPECS_DIR}/${folder}/requirements.md ---`,
		contents["requirements.md"],
		"",
		`--- ${SPECS_DIR}/${folder}/validation.md ---`,
		contents["validation.md"],
		"",
		"Issues to consider: ambiguous requirements, plan steps that don't address the requirements, validation " +
			"criteria that aren't measurable, or a feature scope that conflates several distinct features.",
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
			rule,
			message: `${featureName} review skipped (validator-role LLM unavailable): ${message}`,
		})
		return diagnostics
	}

	if (verdict.coherent) return diagnostics

	for (const issue of verdict.issues) {
		diagnostics.push({
			severity: "warning",
			rule,
			message: `${featureName} review: ${issue}`,
		})
	}
	return diagnostics
}

export const featureSpecCoherent = async (state: OrchestrationState): Promise<ValidationDiagnostic[]> => {
	const specsRoot = join(state.targetDirectory, SPECS_DIR)
	if (!existsSync(specsRoot)) return []

	const folders = readdirSync(specsRoot, { withFileTypes: true })
		.filter((e) => e.isDirectory() && featureNameOf(e.name) !== null)
		.map((e) => e.name)

	if (folders.length === 0) return []

	const allDiagnostics: ValidationDiagnostic[] = []
	for (const folder of folders) {
		const result = await reviewFolder(state, folder)
		allDiagnostics.push(...result)
	}
	return allDiagnostics
}
