import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { createJiti } from "jiti"
import { input, confirm, editor } from "@inquirer/prompts"
import { AgentRole, ModuleManifestSchema, BAKA_EXIT_CODE, type ModuleManifest } from "@repo/protocol"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

const ACTION_CENTRIC_LAYOUT_HELP = `
Action-centric module layout:

  modules/<name>/
  +-- manifest.ts                  # CONTRACT: actions, deps, file patterns
  +-- README.md                    # auto-generated
  +-- <action-id>/
  |   +-- action.ts                # executable (dumb or LLM-assisted)
  |   +-- templates/               # Handlebars, only if requiresReasoning: true
  |   +-- validators/              # action-specific pattern checks
  +-- _shared/                     # OPTIONAL cross-cutting concerns
      +-- templates/
      +-- validators/
      +-- helpers/
`

// ---------------------------------------------------------------------------
// `baka module init <name>`
// ---------------------------------------------------------------------------

interface InitActionInput {
	id: string
	description: string
	requiresReasoning: boolean
	compensatesWith?: string
	params: Array<{ name: string; type: string; required: boolean; description: string; enumValues?: string[] }>
}

async function promptForAction(existingIds: string[]): Promise<InitActionInput> {
	const id = await input({
		message: "Action id (used as the folder name and in plans):",
		validate: (v) => {
			if (v.trim() === "") return "required"
			if (!/^[a-z0-9_-]+$/.test(v)) return "letters, digits, _ and - only"
			if (existingIds.includes(v)) return `already used; pick a different id`
			return true
		},
	})
	const description = await input({ message: `Description for action "${id}":`, validate: (v) => (v.trim() === "" ? "required" : true) })
	const requiresReasoning = await confirm({ message: "Does this action require a small-LLM assist?", default: false })
	let compensatesWith: string | undefined
	if (existingIds.length > 0) {
		const has = await confirm({ message: "Does this action have an inverse (compensatesWith)?", default: false })
		if (has) {
			compensatesWith = await selectActionIdFromList(
				"Which existing action is the inverse?",
				existingIds,
				"(none — first action)",
			)
		}
	}
	const params: InitActionInput["params"] = []
	while (true) {
		const add = await confirm({ message: params.length === 0 ? "Add a parameter?" : "Add another parameter?", default: params.length === 0 })
		if (!add) break
		const pname = await input({ message: "Param name:", validate: (v) => (v.trim() === "" ? "required" : true) })
		const ptype = await input({
			message: "Param type (string|boolean|number|enum):",
			default: "string",
			validate: (v) => ["string", "boolean", "number", "enum"].includes(v) || "must be one of string, boolean, number, enum",
		})
		let enumValues: string[] | undefined
		if (ptype === "enum") {
			const raw = await input({ message: "Enum values (comma-separated):", validate: (v) => (v.split(",").length > 0 ? true : "need at least one") })
			enumValues = raw.split(",").map((s) => s.trim()).filter(Boolean)
		}
		const required = await confirm({ message: "Required?", default: true })
		const description = await input({ message: "Param description:", validate: (v) => (v.trim() === "" ? "required" : true) })
		params.push({ name: pname, type: ptype, required, description, ...(enumValues ? { enumValues } : {}) })
	}
	return { id, description, requiresReasoning, ...(compensatesWith ? { compensatesWith } : {}), params }
}

async function selectActionIdFromList(message: string, ids: string[], _placeholder?: string): Promise<string> {
	const { select } = await import("@inquirer/prompts")
	return select({ message, choices: ids.map((i) => ({ name: i, value: i })) })
}
function renderManifest(name: string, description: string, deps: string[], actions: InitActionInput[]): string {
	const manifest = {
		name,
		version: "0.1.0",
		description,
		dependencies: deps,
		conflictsWith: [],
		actions: actions.map((a) => ({
			id: a.id,
			description: a.description,
			params: a.params,
			requiresReasoning: a.requiresReasoning,
			...(a.compensatesWith ? { compensatesWith: a.compensatesWith } : {}),
			filePatterns: [],
			validators: [],
		})),
		moduleValidators: [],
	}
	return `import type { ModuleManifest } from "@repo/protocol"

export const Manifest: ModuleManifest = ${JSON.stringify(manifest, null, "\t")}
`
}

function renderActionStub(action: InitActionInput): string {
	return `import type { StepResponse, WorkflowStep } from "@repo/protocol"
import { AgentRole } from "@repo/protocol"

export interface ${capitalize(action.id)}Input {
${action.params.map((p) => `\t${p.name}${p.required ? "" : "?"}: ${tsType(p)}`).join("\n")}
}

export interface ${capitalize(action.id)}CompensationData {
\ttargetDirectory: string
\tmoduleName: string
\tactionName: string
\tparameters: Record<string, unknown>
}

export const ${action.id}Action: WorkflowStep<${capitalize(action.id)}Input, boolean, ${capitalize(action.id)}CompensationData> = {
\tname: "${action.id}",
\trole: AgentRole.WORKER,
\texecute: async (input, _state): Promise<StepResponse<boolean, ${capitalize(action.id)}CompensationData>> => {
\t\t// TODO: implement the action body.
\t\t// 1. Use the input params
\t\t// 2. Create/modify files in state.targetDirectory (passed via the orchestrator)
\t\t// 3. Return success/failure with compensationData for rollback
\t\treturn {
\t\t\tsuccess: true,
\t\t\toutput: true,
\t\t\tcompensationData: {
\t\t\t\ttargetDirectory: _state.targetDirectory,
\t\t\t\tmoduleName: "MODULE_NAME",
\t\t\t\tactionName: "${action.id}",
\t\t\t\tparameters: input as Record<string, unknown>,
\t\t\t},
\t\t}
\t},
\tcompensate: async (data, _state): Promise<void> => {
\t\t// TODO: undo what execute did. Delete created files, revert edits, etc.
\t\tvoid data
\t},
}
`
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1)
}

function tsType(p: { type: string; enumValues?: string[] }): string {
	switch (p.type) {
		case "string":
			return "string"
		case "boolean":
			return "boolean"
		case "number":
			return "number"
		case "enum":
			return p.enumValues && p.enumValues.length > 0 ? p.enumValues.map((v) => `"${v}"`).join(" | ") : "string"
		default:
			return "unknown"
	}
}

function renderReadme(name: string, description: string, actions: InitActionInput[]): string {
	return `# ${name}

${description || "(no description yet)"}

## Actions

${actions
	.map(
		(a) =>
			`### \`${a.id}\`

${a.description}

${a.requiresReasoning ? "**Requires LLM assist.**" : "**No LLM involved."}
${a.compensatesWith ? `**Inverse:** \`${a.compensatesWith}\`` : ""}
${
	a.params.length > 0
		? `**Parameters:**

${a.params.map((p) => `- \`${p.name}\` (${p.type}${p.required ? "" : ", optional"}): ${p.description}`).join("\n")}`
		: ""
}
`,
	)
	.join("\n")}
`
}

export async function runModuleInit(name: string): Promise<void> {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module init <name>")
	if (!/^[a-z0-9_-]+$/.test(name)) die(BAKA_EXIT_CODE.USER_ERROR, "module name must be lowercase letters, digits, _ or -")

	const cwd = process.cwd()
	const target = join(cwd, "modules", name)
	if (existsSync(target)) {
		die(BAKA_EXIT_CODE.USER_ERROR, `module already exists at ${target}`)
	}

	console.log(`Creating module "${name}" at ${target}`)
	const description = await input({ message: "Module description:", default: "" })
	const depsRaw = await input({ message: "Dependencies (comma-separated module names, or blank):", default: "" })
	const deps = depsRaw.split(",").map((s) => s.trim()).filter(Boolean)

	const actions: InitActionInput[] = []
	while (true) {
		const add = await confirm({ message: actions.length === 0 ? "Add an action?" : "Add another action?", default: true })
		if (!add) break
		const action = await promptForAction(actions.map((a) => a.id))
		actions.push(action)
	}
	if (actions.length === 0) die(BAKA_EXIT_CODE.USER_ERROR, "module must have at least one action")

	// Write the layout
	mkdirSync(target, { recursive: true })
	writeFileSync(join(target, "manifest.ts"), renderManifest(name, description, deps, actions))
	writeFileSync(join(target, "README.md"), renderReadme(name, description, actions))

	for (const action of actions) {
		const actionDir = join(target, action.id)
		mkdirSync(actionDir, { recursive: true })
		writeFileSync(join(actionDir, "action.ts"), renderActionStub(action))
		if (action.requiresReasoning) {
			mkdirSync(join(actionDir, "templates"), { recursive: true })
			writeFileSync(
				join(actionDir, "templates", `${action.id}.hbs`),
				`{{!-- Handlebars template for ${action.id}. The baka worker renders this with the action's params. --}}\n{{!-- The output of this template is the body that the LLM will fill in. --}}\n`,
			)
		}
	}

	console.log("")
	console.log(`  baka: module "${name}" created with ${actions.length} action(s)`)
	console.log(`    ${target}`)
	console.log(`    next: run \`baka module validate ${name}\` to check the layout`)
}

// ---------------------------------------------------------------------------
// `baka module validate <name>`
// ---------------------------------------------------------------------------

export function runModuleValidate(name: string): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module validate <name>")

	const cwd = process.cwd()
	const root = join(cwd, "modules", name)
	if (!existsSync(root)) die(BAKA_EXIT_CODE.USER_ERROR, `module not found at ${root}`)

	const errors: string[] = []
	const warnings: string[] = []

	const manifestPath = join(root, "manifest.ts")
	if (!existsSync(manifestPath)) {
		errors.push("manifest.ts is missing")
	} else {
		// Parse the manifest by transpiling the TS to JS in-process via jiti
		try {
			const jiti = createJiti(cwd)
			const mod = jiti(manifestPath) as { Manifest?: unknown }
			if (!mod.Manifest) {
				errors.push("manifest.ts must export a `Manifest` value")
			} else {
				const parsed = ModuleManifestSchema.safeParse(mod.Manifest)
				if (!parsed.success) {
					errors.push("manifest does not match ModuleManifestSchema")
					for (const issue of parsed.error.issues) {
						errors.push(`  - ${issue.path.join(".")}: ${issue.message}`)
					}
				} else {
					// Layout enforcement
					for (const action of parsed.data.actions) {
						const actionDir = join(root, action.id)
						if (!existsSync(join(actionDir, "action.ts"))) {
							errors.push(`action "${action.id}" is missing ${action.id}/action.ts`)
						}
						if (action.requiresReasoning) {
							const templatesDir = join(actionDir, "templates")
							if (!existsSync(templatesDir)) {
								errors.push(`action "${action.id}" has requiresReasoning: true but no templates/ folder`)
							} else {
								const hasTemplate = readdirSyncSafe(templatesDir).some((f) => f.endsWith(".hbs"))
								if (!hasTemplate) {
									errors.push(`action "${action.id}" has requiresReasoning: true but no .hbs files in templates/`)
								}
							}
						}
					}
					for (const ruleId of parsed.data.moduleValidators ?? []) {
						const rulePath = join(root, "_shared", "validators", `${ruleId}.ts`)
						if (!existsSync(rulePath)) {
							errors.push(`moduleValidator "${ruleId}" is declared but _shared/validators/${ruleId}.ts does not exist`)
						}
					}
				}
			}
		} catch (err) {
			errors.push(`failed to load manifest.ts: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	// README recommendation
	if (!existsSync(join(root, "README.md"))) warnings.push("README.md is missing")

	if (errors.length > 0) {
		console.log(`module "${name}": INVALID`)
		for (const e of errors) console.log(`  - ${e}`)
		process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
	}
	console.log(`module "${name}": valid`)
	for (const w of warnings) console.log(`  warning: ${w}`)
}

function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

// ---------------------------------------------------------------------------
// `baka module list-actions <name>`
// ---------------------------------------------------------------------------

export function runModuleListActions(name: string): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module list-actions <name>")
	const cwd = process.cwd()
	const manifestPath = join(cwd, "modules", name, "manifest.ts")
	if (!existsSync(manifestPath)) die(BAKA_EXIT_CODE.USER_ERROR, `module not found: ${name}`)

	let mod: { Manifest?: ModuleManifest }
	try {
		const jiti = createJiti(cwd)
		mod = jiti(manifestPath) as { Manifest?: ModuleManifest }
	} catch (err) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `failed to load manifest: ${err instanceof Error ? err.message : String(err)}`)
	}
	if (!mod.Manifest) die(BAKA_EXIT_CODE.ENGINE_ERROR, "manifest.ts did not export a Manifest")
	const m = mod.Manifest
	console.log(`module: ${m.name} v${m.version}`)
	if (m.description) console.log(`  ${m.description}`)
	console.log(`  ${m.actions.length} action(s):`)
	for (const a of m.actions) {
		console.log(`    - ${a.id}: ${a.description}`)
		if (a.requiresReasoning) console.log(`        (requiresReasoning: true)`)
		if (a.compensatesWith) console.log(`        (compensatesWith: ${a.compensatesWith})`)
		if (a.params.length > 0) {
			for (const p of a.params) {
				console.log(`        - ${p.name}${p.required ? "" : "?"} (${p.type}): ${p.description}`)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// `baka module edit <name>`
// ---------------------------------------------------------------------------

export async function runModuleEdit(name: string): Promise<void> {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module edit <name>")
	const editorCmd = process.env.EDITOR
	if (!editorCmd) die(BAKA_EXIT_CODE.USER_ERROR, "no $EDITOR set")
	const cwd = process.cwd()
	const manifestPath = join(cwd, "modules", name, "manifest.ts")
	if (!existsSync(manifestPath)) die(BAKA_EXIT_CODE.USER_ERROR, `module not found: ${name}`)

	const child = spawn(editorCmd, [manifestPath], { stdio: "inherit" })
	await new Promise<void>((resolveProm) => {
		child.on("exit", () => resolveProm())
	})

	// Re-validate after edit
	runModuleValidate(name)
}

// ---------------------------------------------------------------------------
// `baka module test <name> --action=<id> --input=<json>`
// Runs the action in a clean temp dir, prints before/after tree, and runs
// the module's validators. Phase 3 wires this up to the real Worker; for
// Phase 2 it scaffolds the action and reports what would happen.
// ---------------------------------------------------------------------------

export async function runModuleTest(name: string, actionId: string, inputJson: string): Promise<void> {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module test <name> --action=<id> [--input=<json>]")
	if (!actionId) die(BAKA_EXIT_CODE.USER_ERROR, "--action=<id> is required")

	const cwd = process.cwd()
	const root = join(cwd, "modules", name)
	if (!existsSync(root)) die(BAKA_EXIT_CODE.USER_ERROR, `module not found: ${name}`)

	const actionTsPath = join(root, actionId, "action.ts")
	if (!existsSync(actionTsPath)) {
		die(BAKA_EXIT_CODE.USER_ERROR, `action "${actionId}" not found (no ${actionId}/action.ts in module ${name})`)
	}

	let parsedInput: Record<string, unknown> = {}
	if (inputJson && inputJson !== "{}") {
		try {
			parsedInput = JSON.parse(inputJson)
		} catch (err) {
			die(BAKA_EXIT_CODE.USER_ERROR, `--input must be valid JSON: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	// Run the action in a temp dir to isolate FS effects.
	const tempDir = join(tmpdir(), `baka-test-${name}-${actionId}-${Date.now()}`)
	mkdirSync(tempDir, { recursive: true })
	const moduleCopy = join(tempDir, name)
	cpSync(root, moduleCopy, { recursive: true })

	console.log(`running ${name}:${actionId} in ${tempDir}`)
	console.log(`  input: ${JSON.stringify(parsedInput)}`)
	console.log("")

	// Load and run the action in-process via jiti. This avoids spawning a
	// child Node process (which would need its own tsx setup) and keeps the
	// CLI self-contained.
	let exitCode: number = BAKA_EXIT_CODE.SUCCESS
	try {
		const actionPath = join(moduleCopy, actionId, "action.ts")
		const jiti = createJiti(tempDir)
		const mod = jiti(actionPath) as Record<string, unknown>
		const expected = `${actionId}Action`
		const step = (mod[expected] ?? mod.default) as
			| {
					execute: (input: unknown, state: unknown) => Promise<{ success: boolean; output: unknown; error?: string }>
					compensate: (data: unknown, state: unknown) => Promise<void>
			  }
			| undefined
		if (!step || typeof step.execute !== "function") {
			die(BAKA_EXIT_CODE.USER_ERROR, `${actionPath} must export a WorkflowStep named \`${expected}\``)
		}
		const state = {
			userIntent: "test",
			targetDirectory: tempDir,
			status: "EXECUTING",
			executionPlan: { steps: [], currentStepIndex: 0 },
			logs: [],
			artifacts: {},
		}
		const result = await step.execute(parsedInput, state)
		console.log("RESULT:", JSON.stringify(result.output, null, 2))
		if (!result.success) {
			console.error("FAILED:", result.error ?? "(no error message)")
			exitCode = BAKA_EXIT_CODE.ENGINE_ERROR
		}
	} catch (err) {
		console.error("ERROR:", err instanceof Error ? err.message : String(err))
		exitCode = BAKA_EXIT_CODE.ENGINE_ERROR
	}

	// Cleanup
	try {
		rmSync(tempDir, { recursive: true, force: true })
	} catch {
		/* best effort */
	}

	if (exitCode !== BAKA_EXIT_CODE.SUCCESS) {
		process.exit(exitCode)
	}
}
