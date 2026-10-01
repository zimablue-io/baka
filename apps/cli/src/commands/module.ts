import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	findModuleSdkImports,
	loadAction,
	loadActionValidator,
	loadModuleValidator,
	ModuleRegistry,
	parseActionTemplates,
	runAction,
	validatorFilename,
} from "@repo/ast-tooling"
import { BAKA_DEFAULT_WORKER_MODEL, BAKA_EXIT_CODE, type ModuleManifest, ModuleManifestSchema } from "@repo/protocol"
import { createJiti } from "jiti"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

// ---------------------------------------------------------------------------
// `baka module validate <name>`
// ---------------------------------------------------------------------------

/** True when the module's package.json lists `baka-sdk` under `dependencies` (a runtime install the author owns). */
function declaresSdkDependency(moduleRoot: string): boolean {
	try {
		const pkg = JSON.parse(readFileSync(join(moduleRoot, "package.json"), "utf-8")) as {
			dependencies?: Record<string, string>
		}
		return pkg.dependencies?.["baka-sdk"] !== undefined
	} catch {
		return false
	}
}

export function runModuleValidate(
	name: string,
	opts: { cwd?: string; moduleDirs?: string[]; json?: boolean } = {},
): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module validate <name>")

	const cwd = opts.cwd ?? process.cwd()
	// Resolve through the same registry the engine uses so validate sees the
	// same modules plan/apply see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree modules/ dir.
	const root = new ModuleRegistry(cwd, { moduleDirs: opts.moduleDirs }).resolveModuleRoot(name)
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
			const jiti = createJiti(root)
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
						const actionTs = join(actionDir, "action.ts")
						const templatesDir = join(actionDir, "templates")
						const hasAction = existsSync(actionTs)
						const hasTemplates = existsSync(templatesDir)
						if (!hasAction && !hasTemplates) {
							errors.push(`action "${action.id}" is missing ${action.id}/action.ts and ${action.id}/templates/`)
							continue
						}
						if (hasAction) {
							try {
								loadAction(cwd, root, parsed.data, action.id)
							} catch (err) {
								errors.push(
									`action "${action.id}" is not loadable: ${err instanceof Error ? err.message : String(err)}`,
								)
							}
						}
						if (hasTemplates) {
							try {
								parseActionTemplates(templatesDir)
							} catch (err) {
								errors.push(
									`action "${action.id}" templates failed the Handlebars subset: ${err instanceof Error ? err.message : String(err)}`,
								)
							}
						}
						if (action.requiresReasoning && !hasTemplates) {
							errors.push(`action "${action.id}" has requiresReasoning: true but no templates/ folder`)
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

	// baka-sdk is a types-only boundary unless the module opts into installing it: a runtime import cannot load in
	// a catalog without its own node_modules, so it is allowed only when package.json lists baka-sdk in `dependencies`.
	if (!declaresSdkDependency(root)) {
		for (const finding of findModuleSdkImports(root)) {
			errors.push(
				`${finding.file}:${finding.line}: runtime import of "baka-sdk" (\`${finding.statement}\`); baka-sdk is not installed next to a module, so use \`import type\`, or list baka-sdk in the module's package.json dependencies and install it (see docs/MODULES.md, "Public boundary")`,
			)
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

// ---------------------------------------------------------------------------
// `baka module list-actions <name>`
// ---------------------------------------------------------------------------

export function runModuleListActions(
	name: string,
	opts: { cwd?: string; moduleDirs?: string[]; json?: boolean } = {},
): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module list-actions <name>")
	const cwd = opts.cwd ?? process.cwd()
	// Resolve through the same registry the engine uses so list-actions sees
	// the same modules plan/apply/validate see (tree, project marketplace,
	// user marketplace, bundled), not just the in-tree modules/ dir.
	const root = new ModuleRegistry(cwd, { moduleDirs: opts.moduleDirs }).resolveModuleRoot(name)
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
		const jiti = createJiti(root)
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

export async function runModuleEdit(name: string, opts: { cwd?: string; moduleDirs?: string[] } = {}): Promise<void> {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module edit <name>")
	const editorCmd = process.env.EDITOR
	if (!editorCmd) die(BAKA_EXIT_CODE.USER_ERROR, "no $EDITOR set")
	const cwd = opts.cwd ?? process.cwd()
	// Resolve through the same registry the engine uses so edit opens the
	// module plan/apply/validate see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree modules/ dir.
	const root = new ModuleRegistry(cwd, { moduleDirs: opts.moduleDirs }).resolveModuleRoot(name)
	if (!root) die(BAKA_EXIT_CODE.USER_ERROR, `module not found: ${name}`)
	const manifestPath = join(root, "manifest.ts")

	const child = spawn(editorCmd, [manifestPath], { stdio: "inherit" })
	await new Promise<void>((resolveProm) => {
		child.on("exit", () => resolveProm())
	})

	// Re-validate after edit
	runModuleValidate(name, { cwd, moduleDirs: opts.moduleDirs })
}

// ---------------------------------------------------------------------------
// `baka module test <name> --action=<id> --input=<json>`
// Runs the action in a clean temp dir, prints before/after tree, and runs
// the module's validators.
// ---------------------------------------------------------------------------

export async function runModuleTest(
	name: string,
	actionId: string,
	inputJson: string,
	opts: { cwd?: string; moduleDirs?: string[] } = {},
): Promise<void> {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka module test <name> --action=<id> [--input=<json>]")
	if (!actionId) die(BAKA_EXIT_CODE.USER_ERROR, "--action=<id> is required")

	const cwd = opts.cwd ?? process.cwd()
	// Resolve through the same registry the engine uses so `module test`
	// sees the same modules plan/apply see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree modules/ dir.
	const resolved = new ModuleRegistry(cwd, { moduleDirs: opts.moduleDirs }).resolveModuleRoot(name)
	if (!resolved) die(BAKA_EXIT_CODE.USER_ERROR, `module not found: ${name}`)
	// Marketplace installs are symlinks; copy the real directory so the
	// action's writes land in the temp copy, never in the installed source.
	const root = realpathSync(resolved)

	const hasAction = existsSync(join(root, actionId, "action.ts"))
	const hasTemplates = existsSync(join(root, actionId, "templates"))
	if (!hasAction && !hasTemplates) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			`action "${actionId}" not found (no ${actionId}/action.ts or ${actionId}/templates/ in module ${name})`,
		)
	}

	let parsedInput: Record<string, unknown> = {}
	if (inputJson && inputJson !== "{}") {
		try {
			parsedInput = JSON.parse(inputJson)
		} catch (err) {
			die(BAKA_EXIT_CODE.USER_ERROR, `--input must be valid JSON: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	const tempDir = join(tmpdir(), `baka-test-${name}-${actionId}-${Date.now()}`)
	mkdirSync(join(tempDir, "modules"), { recursive: true })
	writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "baka-module-test", private: true }))
	const moduleCopy = join(tempDir, "modules", name)
	cpSync(root, moduleCopy, { recursive: true })

	console.log(`running ${name}:${actionId} in ${tempDir}`)
	console.log(`  input: ${JSON.stringify(parsedInput)}`)
	console.log("")

	let exitCode: number = BAKA_EXIT_CODE.SUCCESS
	try {
		const result = await runAction({
			registry: new ModuleRegistry(tempDir),
			module: name,
			action: actionId,
			params: parsedInput,
			provider: null,
			model: BAKA_DEFAULT_WORKER_MODEL,
			includeContent: true,
		})
		console.log("RESULT:", JSON.stringify(result, null, 2))
		if (!result.ok) {
			console.error("FAILED:", result.diagnostics.find((d) => d.severity === "error")?.message ?? "(no error message)")
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
