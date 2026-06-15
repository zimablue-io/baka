/**
 * The double-diamond module-design flow as an MCP prompt template.
 *
 * MCP `prompts` are user-invoked message templates. The host agent picks
 * the prompt, fills in the args, and the resulting messages get sent to
 * the model. The model then drives the actual interactive REPL — baka-mcp
 * does not run a chat loop itself; that belongs to the host or to the
 * `baka module create <name>` CLI command.
 */
export const DESIGN_MODULE_PROMPT_NAME = "baka_design_module" as const

export const DESIGN_MODULE_DESCRIPTION =
	"Design a new baka module through the chat-driven double-diamond flow (Discover -> Define -> Develop -> Deliver). The model guides the user through four phases, then writes the module's manifest, actions, validators, and templates."

export function designModuleMessages(args: { name: string; resume?: boolean }): Array<{
	role: "user" | "assistant"
	content: { type: "text"; text: string }
}> {
	const name = String(args.name ?? "").trim()
	if (!name) {
		throw new Error("design-module prompt: `name` argument is required")
	}
	const resume = args.resume === true
	const verb = resume ? "resume" : "start"
	return [
		{
			role: "user",
			content: {
				type: "text",
				text: [
					`You are about to ${verb} the baka double-diamond design flow for a new module named \`${name}\`.`,
					``,
					resume
						? `A previous session left the design state under .baka/state/; read it first, then pick up at the appropriate phase.`
						: `Drive the user through four phases, in order:`,
					resume
						? ``
						: [
								`1. DISCOVER — ask the user a few focused questions about the problem the module solves, the conventions they want, and the edge cases they care about. Synthesize the answers into a PREFERENCES.md draft when ready.`,
								`2. DEFINE — propose the action roster (each action a self-contained, declared unit of work). Confirm with the user before moving on.`,
								`3. DEVELOP — for each action, design its params, validators, and (if requiresReasoning: true) handlebars templates. Each action must be a real, executable unit, not a placeholder.`,
								`4. DELIVER — write the manifest.ts, action folders, validators, templates, README, and PREFERENCES.md. Then run the consistency test (5 runs against the same intent, all five plans must match).`,
							].join("\n"),
					``,
					`Ground rules (enforced by the engine, not by your prompting):`,
					`- You may only use modules and actions that appear in the current module catalog. If a new action is needed, add it to the catalog first; do not invent it.`,
					`- Each action's \`params\` must match what its \`action.ts\` actually reads. If the LLM cannot fill a field from a real signal, do not make it a param.`,
					`- Validators are pure TypeScript. They run after the action completes and receive the action's compensationData. Do not put LLM calls in validators.`,
					`- The same intent + the same module catalog must always produce the same plan. If your design would break that invariant, redesign the action.`,
					``,
					`Useful commands to run as you go:`,
					`- \`baka list-modules --json\` to see what is currently installed`,
					`- \`baka module create ${name}\` to drive the design flow interactively from the user's terminal (recommended for the full experience)`,
					`- \`baka module validate ${name}\` after you write the manifest to catch structural errors`,
					`- \`baka module consistency ${name}\` to run the 5x determinism test before declaring done`,
					``,
					resume
						? `Start by reading the existing design state and summarizing where you left off.`
						: `Start with the DISCOVER phase: greet the user, briefly explain what you are about to do, and ask the first focused question.`,
				].join("\n"),
			},
		},
	]
}
