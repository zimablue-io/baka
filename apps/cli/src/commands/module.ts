import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BAKA_EXIT_CODE, type ModuleManifest, ModuleManifestSchema } from "@repo/protocol"
import { createJiti } from "jiti"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

// Note: `baka module init` is replaced by `baka module create`, the
// chat-driven double-diamond flow in ./module-design.ts.

// ---------------------------------------------------------------------------
// `baka module validate <name>`
// ---------------------------------------------------------------------------

export function runModuleValidate(name: string, opts: { json?: boolean } = {}): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module validate <name>")

	const cwd = process.cwd()
	const root = join(cwd, "modules", name)
	if (!existsSync(root)) {
		if (opts.json) {
			console.log(
				JSON.stringify({ module: name, valid: false, errors: [`module not found at ${root}`], warnings: [] }, null, 2),
			)
			process.exit(BAKA_EXIT_CODE.USER_ERROR)
		}
		die(BAKA_EXIT_CODE.USER_ERROR, `module not found at ${root}`)
	}

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

	if (opts.json) {
		console.log(JSON.stringify({ module: name, valid: errors.length === 0, errors, warnings }, null, 2))
		if (errors.length > 0) {
			process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
		}
		return
	}

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
// the module's validators.
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

	// Load and run the action in-process via jiti.
	let exitCode: number = BAKA_EXIT_CODE.SUCCESS
	try {
		const actionPath = join(moduleCopy, actionId, "action.ts")
		const jiti = createJiti(tempDir)
		const mod = jiti(actionPath) as Record<string, unknown>
		// Try the new shape (just the action id) first, then the legacy
		// `${actionId}Action` shape that older modules (e.g. baka-base) use.
		const candidates = [`${actionId}`, `${actionId}Action`, "default"]
		let step:
			| {
					execute: (input: unknown, state: unknown) => Promise<{ success: boolean; output: unknown; error?: string }>
					compensate: (data: unknown, state: unknown) => Promise<void>
			  }
			| undefined
		let matched = ""
		for (const c of candidates) {
			const candidate = mod[c] as { execute?: unknown } | undefined
			if (candidate && typeof candidate.execute === "function") {
				step = candidate as typeof step
				matched = c
				break
			}
		}
		if (!step || typeof step.execute !== "function") {
			die(
				BAKA_EXIT_CODE.USER_ERROR,
				`${actionPath} must export an \`ActionFn\` named \`${actionId}\` (or \`${actionId}Action\` for legacy modules)`,
			)
		}
		void matched
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
