import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { input, confirm, select } from "@inquirer/prompts"
import { BAKA_EXIT_CODE, type LLMMessage } from "@repo/protocol"
import {
	createLLMProvider,
	createModuleDesignStep,
	loadLLMConfig,
	renderActionStubSource,
	renderManifestSource,
	renderPreferencesFile,
	renderTemplateStubSource,
	renderValidatorStubSource,
	validateLLMConfig,
	type DesignTurnInput,
	type DesignTurnPayload,
} from "@repo/agent-engine"
import { runConsistencyTest, type ConsistencyResult } from "@repo/ast-tooling"

// ---------------------------------------------------------------------------
// Chat-driven double diamond module design
//
// Entry point: `baka module create <name>` (or just `baka module create` to
// resume the most recent design session).
//
// The CLI opens a chat REPL. Every turn:
//   1. The LLM is called with the full history and current phase.
//   2. The LLM returns a structured payload (phase, message, structured).
//   3. The CLI renders the message and acts on the structured output.
//   4. The user types a free-form reply (or a slash command).
//
// State is persisted to `modules/<name>/.design-state.json` on every turn
// so the user can quit and resume.
//
// This file is the orchestrator; it owns the REPL loop, the slash
// commands, the phase transitions, the file writes, and the consistency
// test. The LLM is a pure function (runDesignTurn) provided by
// @repo/agent-engine.
// ---------------------------------------------------------------------------

// ----- State shape --------------------------------------------------------

interface DesignState {
	moduleName: string
	brief: string
	phase: "DISCOVER" | "DEFINE" | "DEVELOP" | "DELIVER" | "DONE"
	history: LLMMessage[]
	prefs?: string
	roster?: Array<{ id: string; description: string; rationale: string }>
	designedActions?: Array<DesignedAction>
	createdAt: string
	updatedAt: string
}

interface DesignedAction {
	id: string
	description: string
	params: Array<{ name: string; type: "string" | "number" | "boolean" | "enum"; required: boolean; description: string; enumValues?: string[] }>
	requiresReasoning: boolean
	compensatesWith: string | null
	validators: Array<{ id: string; purpose: string }>
	templates?: Array<{ id: string; outline: string }>
	testIntent: string
}

const STATE_FILE = ".design-state.json"
const PREFS_FILE = "PREFERENCES.md"
const CONSISTENCY_FILE = "CONSISTENCY.md"

// ----- Entry point --------------------------------------------------------

export async function runModuleDesign(name: string, opts: { cwd: string; resume?: boolean }): Promise<void> {
	if (!name) {
		die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module create <name>")
	}
	if (!/^[a-z0-9_-]+$/.test(name)) {
		die(BAKA_EXIT_CODE.USER_ERROR, "module name must be lowercase letters, digits, _ or -")
	}

	const moduleDir = join(opts.cwd, "modules", name)
	const statePath = join(moduleDir, STATE_FILE)
	let state = loadState(statePath)

	if (!state) {
		state = await createFreshState(name, moduleDir, opts.cwd)
	} else {
		console.log(`\n[resuming design session for ${name} — phase: ${state.phase}]\n`)
	}

	// Resolve the LLM provider once. The chat will use it for every turn.
	const config = await loadLLMConfig({ cwd: opts.cwd })
	try {
		validateLLMConfig(config)
	} catch (err) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `LLM config: ${err instanceof Error ? err.message : String(err)}`)
	}
	const provider = createLLMProvider(config)
	const step = createModuleDesignStep(provider)

	// Render the most recent assistant message (if any) so the user sees
	// context on resume.
	renderResumeContext(state)

	// REPL loop
	let lastPayload: DesignTurnPayload | null = null
	while (state.phase !== "DONE") {
		const userText = await input({
			message: "> ",
			// Multi-line answers are rare; inquirer collapses them.
			// For long-form, type `/editor` to use the OS editor.
			validate: (v) => (v.trim() === "" ? "type something, or /exit" : true),
		})
		const trimmed = userText.trim()

		// Slash commands
		if (trimmed.startsWith("/")) {
			const handled = await handleSlash(trimmed, state, moduleDir, statePath, opts.cwd)
			if (handled === "exit") return
			if (handled === "rewound") continue
			continue
		}

		// Push the user message into history, call the LLM, render the
		// response, then act on the structured payload.
		state.history.push({ role: "user", content: userText })

		const llmInput: DesignTurnInput = {
			phase: state.phase,
			brief: state.brief,
			history: state.history,
			...(state.prefs ? { prefs: state.prefs } : {}),
			...(state.roster ? { roster: state.roster } : {}),
			...(state.designedActions ? { designedActions: state.designedActions } : {}),
		}
		const llmResp = await step.execute(llmInput, { userIntent: state.brief, targetDirectory: opts.cwd, status: "PLANNING", executionPlan: { steps: [], currentStepIndex: 0 }, logs: [], artifacts: {} })
		if (!llmResp.success) {
			console.error(`\n[LLM error: ${llmResp.error}]\n`)
			// Pop the user message so the next turn is the same prompt.
			state.history.pop()
			continue
		}
		const { payload, history: updatedHistory } = llmResp.output
		state.history = updatedHistory
		lastPayload = payload
		renderPayload(payload, state)

		// Act on the structured payload (advance phase, write files, etc.)
		const transition = await applyPayload(payload, state, moduleDir, statePath, opts.cwd, name)
		if (transition.phaseChanged) {
			console.log(`\n[phase -> ${state.phase}]\n`)
		}
		// Save state on every turn.
		state.updatedAt = new Date().toISOString()
		saveState(state, statePath)

		// If we just finished DELIVER, we're done.
		if ((state.phase as string) === "DONE") {
			console.log(`\n[done]\n`)
			break
		}
	}
}

// ----- State load/save ----------------------------------------------------

function loadState(statePath: string): DesignState | null {
	if (!existsSync(statePath)) return null
	try {
		return JSON.parse(readFileSync(statePath, "utf-8")) as DesignState
	} catch {
		return null
	}
}

function saveState(state: DesignState, statePath: string): void {
	writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8")
}

async function createFreshState(name: string, moduleDir: string, cwd: string): Promise<DesignState> {
	if (existsSync(moduleDir) && !existsSync(join(moduleDir, "manifest.ts"))) {
		die(BAKA_EXIT_CODE.USER_ERROR, `path exists but is not a baka module: ${moduleDir}. Move or remove it first.`)
	}
	mkdirSync(moduleDir, { recursive: true })
	const brief = await input({
		message: `In one or two sentences, what should the module "${name}" do?`,
		validate: (v) => (v.trim().length > 5 ? true : "give me a bit more"),
	})
	return {
		moduleName: name,
		brief,
		phase: "DISCOVER",
		history: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
}

function renderResumeContext(state: DesignState): void {
	const last = state.history[state.history.length - 1]
	if (last && last.role === "assistant") {
		console.log(`\n[last assistant message]\n${last.content}\n`)
	}
}

// ----- Render LLM payload -------------------------------------------------

function renderPayload(payload: DesignTurnPayload, state: DesignState): void {
	console.log(`\n${payload.message}\n`)

	switch (payload.phase) {
		case "DISCOVER":
			if (payload.questions.length > 0) {
				console.log(`Questions:`)
				for (const q of payload.questions) {
					console.log(`  [${q.id}] ${q.prompt}`)
					console.log(`        why: ${q.whyWeNeedThis}`)
				}
				console.log(``)
			}
			if (payload.finished && payload.synthesizedPrefs) {
				console.log(`[LLM has synthesized PREFERENCES.md]`)
			}
			break
		case "DEFINE":
			if (payload.actions.length > 0) {
				console.log(`Proposed actions:`)
				for (const a of payload.actions) {
					console.log(`  - ${a.id}: ${a.description}`)
					console.log(`        ${a.rationale}`)
				}
				console.log(``)
			}
			break
		case "DEVELOP":
			if (payload.actions.length > 0) {
				for (const a of payload.actions) {
					console.log(`  ${a.id}:`)
					console.log(`    params: ${a.params.length}`)
					for (const p of a.params) {
						const req = p.required ? "required" : "optional"
						const enumHint = p.enumValues ? ` [${p.enumValues.join("|")}]` : ""
						console.log(`      - ${p.name} (${p.type}${enumHint}, ${req}): ${p.description}`)
					}
					console.log(`    requiresReasoning: ${a.requiresReasoning}`)
					console.log(`    compensatesWith: ${a.compensatesWith ?? "(none)"}`)
					console.log(`    validators: ${a.validators.map((v) => v.id).join(", ")}`)
					if (a.templates && a.templates.length > 0) {
						console.log(`    templates: ${a.templates.map((t) => t.id).join(", ")}`)
					}
					console.log(`    testIntent: "${a.testIntent}"`)
				}
				console.log(``)
			}
			break
		case "DELIVER":
			console.log(`[${payload.message}]`)
			break
	}
}

// ----- Apply structured payload (the state machine) -----------------------

interface ApplyResult {
	phaseChanged: boolean
}

async function applyPayload(
	payload: DesignTurnPayload,
	state: DesignState,
	moduleDir: string,
	statePath: string,
	cwd: string,
	moduleName: string,
): Promise<ApplyResult> {
	const result: ApplyResult = { phaseChanged: false }

	switch (payload.phase) {
		case "DISCOVER": {
			if (payload.finished && payload.synthesizedPrefs) {
				state.prefs = payload.synthesizedPrefs
				writeFileSync(join(moduleDir, PREFS_FILE), renderPreferencesFile(moduleName, payload.synthesizedPrefs), "utf-8")
				state.phase = "DEFINE"
				result.phaseChanged = true
			} else {
				// Stay in DISCOVER; renderPayload already showed the questions.
				// The next user turn is the answer; the LLM will then synthesize.
			}
			break
		}
		case "DEFINE": {
			state.roster = payload.actions.map((a) => ({ id: a.id, description: a.description, rationale: a.rationale }))
			if (payload.finished) {
				state.phase = "DEVELOP"
				result.phaseChanged = true
			}
			break
		}
		case "DEVELOP": {
			// Merge the LLM's designed actions with the existing roster.
			const designed: DesignedAction[] = payload.actions.map((a) => ({
				id: a.id,
				description: state.roster?.find((r) => r.id === a.id)?.description ?? a.id,
				params: a.params.map((p) => ({
					name: p.name,
					type: p.type,
					required: p.required,
					description: p.description,
					...(p.enumValues ? { enumValues: p.enumValues } : {}),
				})),
				requiresReasoning: a.requiresReasoning,
				compensatesWith: a.compensatesWith ?? null,
				validators: a.validators.map((v) => ({ id: v.id, purpose: v.purpose })),
				...(a.templates && a.templates.length > 0
					? { templates: a.templates.map((t) => ({ id: t.id, outline: t.outline })) }
					: {}),
				testIntent: a.testIntent,
			}))
			state.designedActions = designed
			if (payload.finished) {
				state.phase = "DELIVER"
				result.phaseChanged = true
			}
			break
		}
		case "DELIVER": {
			// Write the module files.
			await writeModuleFiles(state, moduleDir, moduleName)
			console.log(`\n[files written; running validate + consistency test]\n`)
			const ok = await runValidationAndConsistency(state, moduleDir, cwd, moduleName)
			if (ok) {
				state.phase = "DONE"
				result.phaseChanged = true
			} else {
				// Send the user back to DEVELOP with the failure context.
				state.phase = "DEVELOP"
				result.phaseChanged = true
			}
			break
		}
	}
	return result
}

// ----- Slash commands -----------------------------------------------------

type SlashOutcome = "ok" | "exit" | "rewound"

async function handleSlash(text: string, state: DesignState, moduleDir: string, statePath: string, cwd: string): Promise<SlashOutcome> {
	const parts = text.slice(1).split(/\s+/)
	const cmd = parts[0]?.toLowerCase() ?? ""

	switch (cmd) {
		case "exit":
		case "quit":
		case "q":
			console.log(`\n[session saved to ${statePath}; resume with \`baka module create ${state.moduleName}\`]\n`)
			return "exit"
		case "save":
			saveState(state, statePath)
			console.log(`[saved]`)
			return "ok"
		case "show": {
			const what = parts[1]
			if (!what) {
				console.log(`usage: /show prefs|actions|<action-id>`)
				return "ok"
			}
			if (what === "prefs") {
				console.log(state.prefs ?? "(no preferences synthesized yet)")
				return "ok"
			}
			if (what === "actions") {
				const designed: Array<{ id: string; description: string }> = state.designedActions ?? []
				const roster: Array<{ id: string; rationale: string }> = state.roster ?? []
				for (const a of designed) console.log(`  - ${a.id}: ${a.description}`)
				for (const a of roster) console.log(`  - ${a.id}: ${a.rationale}`)
				return "ok"
			}
			const found = state.designedActions?.find((a) => a.id === what)
			if (found) {
				console.log(JSON.stringify(found, null, 2))
				return "ok"
			}
			console.log(`(no action named "${what}")`)
			return "ok"
		}
		case "rewind":
		case "undo": {
			// Pop the last user message AND the assistant's response to it.
			if (state.history.length < 2) {
				console.log(`(nothing to rewind)`)
				return "ok"
			}
			state.history.pop() // assistant
			state.history.pop() // user
			console.log(`[last turn rewound; re-asking the LLM]`)
			return "rewound"
		}
		case "back": {
			const target = (parts[1] ?? "").toUpperCase()
			const phases = ["DISCOVER", "DEFINE", "DEVELOP", "DELIVER"] as const
			if (!phases.includes(target as (typeof phases)[number])) {
				console.log(`usage: /back <DISCOVER|DEFINE|DEVELOP|DELIVER>`)
				return "ok"
			}
			state.phase = target as DesignState["phase"]
			console.log(`[phase set to ${state.phase}]`)
			return "ok"
		}
		case "skip": {
			console.log(`[advancing phase as-is]`)
			if (state.phase === "DISCOVER") {
				state.prefs = state.prefs ?? `# ${state.moduleName}\n\n(LLM was skipped; no preferences were synthesized.)\n`
				writeFileSync(join(moduleDir, PREFS_FILE), renderPreferencesFile(state.moduleName, state.prefs), "utf-8")
				state.phase = "DEFINE"
			} else if (state.phase === "DEFINE") {
				state.roster = state.roster ?? [{ id: "init", description: "Default initialization action", rationale: "Default when LLM is skipped" }]
				state.phase = "DEVELOP"
			} else if (state.phase === "DEVELOP") {
				state.designedActions = state.designedActions ?? [
					{
						id: state.roster?.[0]?.id ?? "init",
						description: state.roster?.[0]?.description ?? "Default action",
						params: [],
						requiresReasoning: false,
						compensatesWith: null,
						validators: [],
						testIntent: `use ${state.moduleName}`,
					},
				]
				state.phase = "DELIVER"
			} else if (state.phase === "DELIVER") {
				state.phase = "DONE"
			}
			return "ok"
		}
		case "consistency": {
			// Ad-hoc 5x run on the current module.
			const action = state.designedActions?.[0]
			if (!action) {
				console.log(`(need at least one designed action first; finish DEVELOP or /skip)`)
				return "ok"
			}
			const n = Number(parts[1] ?? "5")
			const intent = parts.slice(2).join(" ") || action.testIntent
			const result = await runConsistencyTest({
				cwd,
				moduleName: state.moduleName,
				actionId: action.id,
				intent,
				n,
			})
			printConsistencyResult(result)
			return "ok"
		}
		case "validate": {
			console.log(`[run baka module validate ${state.moduleName}]`)
			// The actual validate is run inside the DELIVER phase. This is a
			// placeholder for a future ad-hoc validator.
			console.log(`(validate runs automatically during DELIVER)`)
			return "ok"
		}
		case "help":
		case "?":
			console.log(
				`Slash commands:\n` +
					`  /save                          - save state to disk\n` +
					`  /show prefs                    - show current PREFERENCES.md\n` +
					`  /show actions                  - show the action roster\n` +
					`  /show <action-id>              - show the design for one action\n` +
					`  /rewind                        - pop the last turn and re-ask the LLM\n` +
					`  /back <DISCOVER|DEFINE|DEVELOP|DELIVER>\n` +
					`                                - jump back to a phase\n` +
					`  /skip                          - accept the LLM's current proposal as-is\n` +
					`  /consistency [n] [intent]      - run the 5x consistency test now\n` +
					`  /exit                          - save and quit`,
			)
			return "ok"
		default:
			console.log(`(unknown command: ${cmd}; type /help)`)
			return "ok"
	}
}

// ----- File writing (DELIVER phase) ---------------------------------------

async function writeModuleFiles(state: DesignState, moduleDir: string, moduleName: string): Promise<void> {
	mkdirSync(moduleDir, { recursive: true })

	// manifest.ts
	const manifest = renderManifestSource(
		moduleName,
		state.prefs?.split("\n")[0] ?? "Auto-generated module.",
		[],
		(state.designedActions ?? []).map((a) => ({
			id: a.id,
			description: a.description,
			params: a.params,
			requiresReasoning: a.requiresReasoning,
			compensatesWith: a.compensatesWith,
			validators: a.validators,
		})),
	)
	writeFileSync(join(moduleDir, "manifest.ts"), manifest, "utf-8")

	// per-action files
	for (const a of state.designedActions ?? []) {
		const actionDir = join(moduleDir, a.id)
		mkdirSync(actionDir, { recursive: true })
		writeFileSync(join(actionDir, "action.ts"), renderActionStubSource(a), "utf-8")
		// validators
		for (const v of a.validators) {
			mkdirSync(join(actionDir, "validators"), { recursive: true })
			writeFileSync(join(actionDir, "validators", `${v.id}.ts`), renderValidatorStubSource(v.id, v.purpose), "utf-8")
		}
		// templates
		if (a.requiresReasoning) {
			mkdirSync(join(actionDir, "templates"), { recursive: true })
			for (const t of a.templates ?? []) {
				writeFileSync(
					join(actionDir, "templates", `${t.id}.hbs`),
					renderTemplateStubSource(a.id, t.id, t.outline),
					"utf-8",
				)
			}
		}
	}

	// package.json
	writeFileSync(
		join(moduleDir, "package.json"),
		`{
  "name": "@${moduleName}",
  "version": "0.1.0",
  "private": true,
  "main": "./manifest.ts",
  "dependencies": {
    "baka-sdk": "workspace:*"
  },
  "peerDependencies": {
    "baka": "*"
  },
  "keywords": ["baka-module"]
}
`,
		"utf-8",
	)

	// tsconfig.json
	writeFileSync(
		join(moduleDir, "tsconfig.json"),
		`{
  "extends": "@repo/typescript-config/base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "baka-sdk": ["../../packages/baka-sdk/src/index.ts"]
    }
  },
  "include": ["**/*.ts"]
}
`,
		"utf-8",
	)

	// README
	const readme = `# ${moduleName}\n\n${state.prefs?.split("\n").slice(1).join("\n").trim() || "Auto-generated module."}\n\n## Actions\n\n${
		(state.designedActions ?? [])
			.map(
				(a) =>
					`### \`${a.id}\`\n\n${a.description}\n\n${a.requiresReasoning ? "**Requires LLM assist.**" : "**No LLM involved."}\n${
						a.compensatesWith ? `**Inverse:** \`${a.compensatesWith}\`\n` : ""
					}Parameters:\n\n${a.params.map((p) => `- \`${p.name}\` (${p.type}${p.required ? "" : ", optional"}): ${p.description}`).join("\n") || "_no params_"}\n`,
			)
			.join("\n")
	}\n`
	writeFileSync(join(moduleDir, "README.md"), readme, "utf-8")
}

// ----- Validation + consistency test (DELIVER phase) ----------------------

async function runValidationAndConsistency(state: DesignState, moduleDir: string, cwd: string, moduleName: string): Promise<boolean> {
	// 1. Quick schema check: read manifest.ts back, parse it, ensure the
	//    designed actions all have action.ts files.
	const manifestPath = join(moduleDir, "manifest.ts")
	if (!existsSync(manifestPath)) {
		console.error(`[FAIL] manifest.ts was not written`)
		return false
	}
	for (const a of state.designedActions ?? []) {
		if (!existsSync(join(moduleDir, a.id, "action.ts"))) {
			console.error(`[FAIL] action.ts missing for ${a.id}`)
			return false
		}
		for (const v of a.validators) {
			if (!existsSync(join(moduleDir, a.id, "validators", `${v.id}.ts`))) {
				console.error(`[FAIL] validator ${v.id}.ts missing for ${a.id}`)
				return false
			}
		}
	}

	// 2. Consistency test on the first action. We need a fresh baka state
	//    in a temp dir so the marketplace-installed module is in scope.
	const action = state.designedActions?.[0]
	if (!action) {
		console.error(`[FAIL] no actions to test`)
		return false
	}
	console.log(`[consistency test: ${moduleName}:${action.id} x 5]`)

	// Install the freshly written module into a temp project dir.
	const { join: joinPath } = await import("node:path")
	const { tmpdir } = await import("node:os")
	const tempDir = joinPath(tmpdir(), `baka-design-${moduleName}-${Date.now()}`)
	mkdirSync(joinPath(tempDir, ".baka", "modules"), { recursive: true })
	// Symlink the module into the temp project's .baka/modules/.
	const { symlinkSync } = await import("node:fs")
	symlinkSync(moduleDir, joinPath(tempDir, ".baka", "modules", moduleName), "dir")
	// Mirror the source baka-base + ts-style into the temp project as
	// in-tree modules so the LLM has scaffold + add-script + add-dependency
	// to compose plans from. (We are testing that the new module's actions
	// appear consistently, not the existing modules.)
	for (const dep of ["baka-base"]) {
		symlinkSync(joinPath(cwd, "modules", dep), joinPath(tempDir, "modules", dep), "dir")
	}

	let result: ConsistencyResult
	try {
		result = await runConsistencyTest({
			cwd: tempDir,
			moduleName,
			actionId: action.id,
			intent: action.testIntent,
			n: 5,
		})
	} catch (err) {
		console.error(`[consistency test threw: ${err instanceof Error ? err.message : String(err)}]`)
		try {
			rmSync(tempDir, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
		return false
	}

	printConsistencyResult(result)
	// Save the trace into the module dir.
	writeFileSync(join(moduleDir, CONSISTENCY_FILE), renderConsistencyMarkdown(result), "utf-8")

	try {
		rmSync(tempDir, { recursive: true, force: true })
	} catch {
		/* best effort */
	}

	if (!result.passed) {
		console.log(`\n[consistency failed; returning to DEVELOP so you can refine the action's params/validators]\n`)
	}
	return result.passed
}

function printConsistencyResult(result: ConsistencyResult): void {
	console.log(
		`\n[consistency: ${result.passed ? "PASS" : "FAIL"} — ${result.n} run(s) for ${result.moduleName}:${result.actionId}]`,
	)
	for (const r of result.perRun) {
		console.log(`  run ${r.runIndex}: ${r.planActions.length} plan step(s), ${r.files.length} file(s), apply exit ${r.applyExitCode}`)
	}
	if (result.divergences.length > 0) {
		console.log(`  divergences:`)
		for (const d of result.divergences.slice(0, 10)) console.log(`    - ${d}`)
		if (result.divergences.length > 10) console.log(`    ... (${result.divergences.length - 10} more)`)
	}
	console.log(`  trace: ${result.artifactDir}`)
}

function renderConsistencyMarkdown(result: ConsistencyResult): string {
	const lines: string[] = [
		`# Consistency report: ${result.moduleName}:${result.actionId}`,
		``,
		`**Intent:** ${result.intent}`,
		`**Runs:** ${result.n}`,
		`**Result:** ${result.passed ? "PASS" : "FAIL"}`,
		``,
		`## Per-run trace`,
		``,
	]
	for (const r of result.perRun) {
		lines.push(`### Run ${r.runIndex} (${r.durationMs}ms, apply exit ${r.applyExitCode})`)
		lines.push(``)
		lines.push(`- Plan actions: \`${r.planActions.join(" -> ")}\``)
		lines.push(`- Plan params: \`${JSON.stringify(r.planParams)}\``)
		lines.push(`- Files (${r.files.length}):`)
		for (const f of r.files) lines.push(`  - \`${f}\`  \`${r.fileHashes[f]?.slice(0, 12) ?? "?"}\``)
		lines.push(``)
	}
	if (result.divergences.length > 0) {
		lines.push(`## Divergences`)
		lines.push(``)
		for (const d of result.divergences) lines.push(`- ${d}`)
		lines.push(``)
	}
	return lines.join("\n")
}

// ----- Misc helpers -------------------------------------------------------

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

// ---------------------------------------------------------------------------
// `baka module consistency <name>` — re-run the 5x consistency test on an
// existing module. Reads the manifest, picks the first action, runs the
// test, prints the result.
// ---------------------------------------------------------------------------

export async function runModuleConsistency(
	name: string,
	opts: { cwd: string; actionId?: string; intent?: string; n?: number },
): Promise<void> {
	const moduleDir = join(opts.cwd, "modules", name)
	const statePath = join(moduleDir, STATE_FILE)
	const state = loadState(statePath)
	const actionId = opts.actionId ?? state?.designedActions?.[0]?.id
	if (!actionId) {
		die(BAKA_EXIT_CODE.USER_ERROR, `could not determine action id; pass --action=<id>`)
	}
	const intent =
		opts.intent ?? state?.designedActions?.find((a) => a.id === actionId)?.testIntent ?? `use ${name}:${actionId}`
	const n = opts.n ?? 5

	// Install the module into a temp project that also has baka-base
	// available, so the LLM can plan compound intents.
	const { tmpdir } = await import("node:os")
	const tempDir = join(tmpdir(), `baka-consistency-${name}-${Date.now()}`)
	mkdirSync(join(tempDir, ".baka", "modules"), { recursive: true })
	const { symlinkSync } = await import("node:fs")
	symlinkSync(moduleDir, join(tempDir, ".baka", "modules", name), "dir")
	symlinkSync(join(opts.cwd, "modules", "baka-base"), join(tempDir, "modules", "baka-base"), "dir")

	const result = await runConsistencyTest({
		cwd: tempDir,
		moduleName: name,
		actionId,
		intent,
		n,
	})
	printConsistencyResult(result)
	try {
		rmSync(tempDir, { recursive: true, force: true })
	} catch {
		/* best effort */
	}
	if (!result.passed) process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
}
