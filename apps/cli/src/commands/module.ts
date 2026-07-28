import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	loadAction,
	loadActionValidator,
	loadModuleValidator,
	ModuleRegistry,
	validatorFilename,
} from "@repo/ast-tooling"
import { BAKA_EXIT_CODE, type ModuleManifest, ModuleManifestSchema, type OrchestrationState } from "@repo/protocol"
import { createJiti } from "jiti"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

// ---------------------------------------------------------------------------
// `baka module validate <name>`
// ---------------------------------------------------------------------------

export function runModuleValidate(name: string, opts: { json?: boolean } = {}): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module validate <name>")

	const cwd = process.cwd()
	// Resolve through the same registry the engine uses so validate sees the
	// same modules plan/apply see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree modules/ dir.
	const root = new ModuleRegistry(cwd).resolveModuleRoot(name)
	if (!root) {
		const msg = `module not found: ${name} (searched tree, project marketplace, user marketplace, and bundled scopes)`
		if (opts.json) {
			console.log(JSON.stringify({ module: name, valid: false, errors: [msg], warnings: [] }, null, 2))
			process.exit(BAKA_EXIT_CODE.USER_ERROR)
		}
		die(BAKA_EXIT_CODE.USER_ERROR, msg)
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
					// Layout enforcement + loadability gate: declared actions and validators
					// must actually import through the same loader the engine uses.
					for (const action of parsed.data.actions) {
						const actionDir = join(root, action.id)
						if (!existsSync(join(actionDir, "action.ts"))) {
							errors.push(`action "${action.id}" is missing ${action.id}/action.ts`)
							continue
						}
						try {
							loadAction(cwd, root, parsed.data, action.id)
						} catch (err) {
							errors.push(`action "${action.id}" is not loadable: ${err instanceof Error ? err.message : String(err)}`)
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
						for (const validatorId of action.validators ?? []) {
							const ruleFile = validatorFilename(validatorId)
							const rulePath = join(actionDir, "validators", `${ruleFile}.ts`)
							if (!existsSync(rulePath)) {
								errors.push(
									`action "${action.id}" validator "${validatorId}" is declared but ${action.id}/validators/${ruleFile}.ts does not exist`,
								)
								continue
							}
							try {
								loadActionValidator(cwd, root, action.id, validatorId)
							} catch (err) {
								errors.push(
									`action "${action.id}" validator "${validatorId}" is not loadable: ${err instanceof Error ? err.message : String(err)}`,
								)
							}
						}
					}
					for (const ruleId of parsed.data.moduleValidators ?? []) {
						const ruleFile = validatorFilename(ruleId)
						const rulePath = join(root, "_shared", "validators", `${ruleFile}.ts`)
						if (!existsSync(rulePath)) {
							errors.push(
								`moduleValidator "${ruleId}" is declared but _shared/validators/${ruleFile}.ts does not exist`,
							)
							continue
						}
						try {
							loadModuleValidator(cwd, root, ruleId)
						} catch (err) {
							errors.push(
								`moduleValidator "${ruleId}" is not loadable: ${err instanceof Error ? err.message : String(err)}`,
							)
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

export function runModuleListActions(name: string, opts: { json?: boolean } = {}): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module list-actions <name>")
	const cwd = process.cwd()
	// Resolve through the same registry the engine uses so list-actions sees
	// the same modules plan/apply/validate see (tree, project marketplace,
	// user marketplace, bundled), not just the in-tree modules/ dir.
	const root = new ModuleRegistry(cwd).resolveModuleRoot(name)
	if (!root) {
		const msg = `module not found: ${name} (searched tree, project marketplace, user marketplace, and bundled scopes)`
		if (opts.json) {
			console.log(JSON.stringify({ module: name, error: msg }, null, 2))
			process.exit(BAKA_EXIT_CODE.USER_ERROR)
		}
		die(BAKA_EXIT_CODE.USER_ERROR, msg)
	}
	const manifestPath = join(root, "manifest.ts")

	let mod: { Manifest?: ModuleManifest }
	try {
		const jiti = createJiti(cwd)
		mod = jiti(manifestPath) as { Manifest?: ModuleManifest }
	} catch (err) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `failed to load manifest: ${err instanceof Error ? err.message : String(err)}`)
	}
	if (!mod.Manifest) die(BAKA_EXIT_CODE.ENGINE_ERROR, "manifest.ts did not export a Manifest")
	const m = mod.Manifest
	if (opts.json) {
		// Same shape as the MCP `baka_list_actions` tool output.
		console.log(
			JSON.stringify(
				{
					module: m.name,
					version: m.version,
					description: m.description,
					actions: m.actions.map((a) => ({
						id: a.id,
						description: a.description,
						requiresReasoning: a.requiresReasoning,
						...(a.compensatesWith ? { compensatesWith: a.compensatesWith } : {}),
						params: a.params.map((p) => ({
							name: p.name,
							type: p.type,
							required: p.required,
							description: p.description,
							...(p.enumValues ? { enumValues: p.enumValues } : {}),
						})),
					})),
				},
				null,
				2,
			),
		)
		return
	}
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
	// Resolve through the same registry the engine uses so edit opens the
	// module plan/apply/validate see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree modules/ dir.
	const root = new ModuleRegistry(cwd).resolveModuleRoot(name)
	if (!root) die(BAKA_EXIT_CODE.USER_ERROR, `module not found: ${name}`)
	const manifestPath = join(root, "manifest.ts")

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
	// Resolve through the same registry the engine uses so `module test`
	// sees the same modules plan/apply see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree modules/ dir.
	const resolved = new ModuleRegistry(cwd).resolveModuleRoot(name)
	if (!resolved) die(BAKA_EXIT_CODE.USER_ERROR, `module not found: ${name}`)
	// Marketplace installs are symlinks; copy the real directory so the
	// action's writes land in the temp copy, never in the installed source.
	const root = realpathSync(resolved)

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

	// Run the action in a temp copy of the module so the targetDirectory is a
	// real project-like root (with package.json, etc.) while still isolating FS
	// effects from the user's actual module source.
	const tempDir = join(tmpdir(), `baka-test-${name}-${actionId}-${Date.now()}`)
	mkdirSync(tempDir, { recursive: true })
	const moduleCopy = join(tempDir, name)
	cpSync(root, moduleCopy, { recursive: true })

	console.log(`running ${name}:${actionId} in ${moduleCopy}`)
	console.log(`  input: ${JSON.stringify(parsedInput)}`)
	console.log("")

	// Load and run the action in-process via the same loader the engine uses.
	let exitCode: number = BAKA_EXIT_CODE.SUCCESS
	try {
		const manifestPath = join(moduleCopy, "manifest.ts")
		const jiti = createJiti(moduleCopy)
		const mod = jiti(manifestPath) as { Manifest?: ModuleManifest }
		if (!mod.Manifest) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, "manifest.ts did not export a Manifest")
		}
		const loaded = loadAction<Record<string, unknown>, unknown, unknown>(moduleCopy, moduleCopy, mod.Manifest, actionId)
		const state = {
			userIntent: "test",
			targetDirectory: moduleCopy,
			status: "EXECUTING",
			executionPlan: { steps: [], currentStepIndex: 0 },
			logs: [],
			artifacts: {},
		} as OrchestrationState
		const result = await loaded.step.execute(parsedInput, state)
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
