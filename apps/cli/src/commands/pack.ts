import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	findPackSdkImports,
	loadPackValidator,
	loadRecipe,
	loadRecipeValidator,
	PackRegistry,
	parseRecipeTemplates,
	runRecipe,
	validatorFilename,
} from "@repo/ast-tooling"
import { BAKA_DEFAULT_WORKER_MODEL, BAKA_EXIT_CODE, type PackManifest, PackManifestSchema } from "@repo/protocol"
import { createJiti } from "jiti"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

// ---------------------------------------------------------------------------
// `baka pack validate <name>`
// ---------------------------------------------------------------------------

/** True when the pack's package.json lists `baka-sdk` under `dependencies` (a runtime install the author owns). */
function declaresSdkDependency(packRoot: string): boolean {
	try {
		const pkg = JSON.parse(readFileSync(join(packRoot, "package.json"), "utf-8")) as {
			dependencies?: Record<string, string>
		}
		return pkg.dependencies?.["baka-sdk"] !== undefined
	} catch {
		return false
	}
}

export function runPackValidate(name: string, opts: { cwd?: string; packDirs?: string[]; json?: boolean } = {}): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka pack validate <name>")

	const cwd = opts.cwd ?? process.cwd()
	// Resolve through the same registry the engine uses so validate sees the
	// same packs plan/apply see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree packs/ dir.
	const root = new PackRegistry(cwd, { packDirs: opts.packDirs }).resolvePackRoot(name)
	if (!root) {
		const msg = `pack not found: ${name} (searched tree, project marketplace, user marketplace, and bundled scopes)`
		if (opts.json) {
			console.log(JSON.stringify({ pack: name, valid: false, errors: [msg], warnings: [] }, null, 2))
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
				const parsed = PackManifestSchema.safeParse(mod.Manifest)
				if (!parsed.success) {
					errors.push("manifest does not match PackManifestSchema")
					for (const issue of parsed.error.issues) {
						errors.push(`  - ${issue.path.join(".")}: ${issue.message}`)
					}
				} else {
					// Layout enforcement + loadability gate: declared recipes and validators
					// must actually import through the same loader the engine uses.
					for (const recipe of parsed.data.recipes) {
						const recipeDir = join(root, recipe.id)
						const recipeTs = join(recipeDir, "recipe.ts")
						const templatesDir = join(recipeDir, "templates")
						const hasRecipe = existsSync(recipeTs)
						const hasTemplates = existsSync(templatesDir)
						if (!hasRecipe && !hasTemplates) {
							errors.push(`recipe "${recipe.id}" is missing ${recipe.id}/recipe.ts and ${recipe.id}/templates/`)
							continue
						}
						if (hasRecipe) {
							try {
								loadRecipe(cwd, root, parsed.data, recipe.id)
							} catch (err) {
								errors.push(
									`recipe "${recipe.id}" is not loadable: ${err instanceof Error ? err.message : String(err)}`,
								)
							}
						}
						if (hasTemplates) {
							try {
								parseRecipeTemplates(templatesDir)
							} catch (err) {
								errors.push(
									`recipe "${recipe.id}" templates failed the Handlebars subset: ${err instanceof Error ? err.message : String(err)}`,
								)
							}
						}
						if (recipe.requiresReasoning && !hasTemplates) {
							errors.push(`recipe "${recipe.id}" has requiresReasoning: true but no templates/ folder`)
						}
						for (const validatorId of recipe.validators ?? []) {
							const ruleFile = validatorFilename(validatorId)
							const rulePath = join(recipeDir, "validators", `${ruleFile}.ts`)
							if (!existsSync(rulePath)) {
								errors.push(
									`recipe "${recipe.id}" validator "${validatorId}" is declared but ${recipe.id}/validators/${ruleFile}.ts does not exist`,
								)
								continue
							}
							try {
								loadRecipeValidator(cwd, root, recipe.id, validatorId)
							} catch (err) {
								errors.push(
									`recipe "${recipe.id}" validator "${validatorId}" is not loadable: ${err instanceof Error ? err.message : String(err)}`,
								)
							}
						}
					}
					for (const ruleId of parsed.data.packValidators ?? []) {
						const ruleFile = validatorFilename(ruleId)
						const rulePath = join(root, "_shared", "validators", `${ruleFile}.ts`)
						if (!existsSync(rulePath)) {
							errors.push(`packValidator "${ruleId}" is declared but _shared/validators/${ruleFile}.ts does not exist`)
							continue
						}
						try {
							loadPackValidator(cwd, root, ruleId)
						} catch (err) {
							errors.push(
								`packValidator "${ruleId}" is not loadable: ${err instanceof Error ? err.message : String(err)}`,
							)
						}
					}
				}
			}
		} catch (err) {
			errors.push(`failed to load manifest.ts: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	// baka-sdk is a types-only boundary unless the pack opts into installing it: a runtime import cannot load in
	// a catalog without its own node_modules, so it is allowed only when package.json lists baka-sdk in `dependencies`.
	if (!declaresSdkDependency(root)) {
		for (const finding of findPackSdkImports(root)) {
			errors.push(
				`${finding.file}:${finding.line}: runtime import of "baka-sdk" (\`${finding.statement}\`); baka-sdk is not installed next to a pack, so use \`import type\`, or list baka-sdk in the pack's package.json dependencies and install it (see docs/PACKS.md, "Public boundary")`,
			)
		}
	}

	// README recommendation
	if (!existsSync(join(root, "README.md"))) warnings.push("README.md is missing")

	if (opts.json) {
		console.log(JSON.stringify({ pack: name, valid: errors.length === 0, errors, warnings }, null, 2))
		if (errors.length > 0) {
			process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
		}
		return
	}

	if (errors.length > 0) {
		console.log(`pack "${name}": INVALID`)
		for (const e of errors) console.log(`  - ${e}`)
		process.exit(BAKA_EXIT_CODE.VALIDATION_ERROR)
	}
	console.log(`pack "${name}": valid`)
	for (const w of warnings) console.log(`  warning: ${w}`)
}

// ---------------------------------------------------------------------------
// `baka pack list-recipes <name>`
// ---------------------------------------------------------------------------

export function runPackListRecipes(
	name: string,
	opts: { cwd?: string; packDirs?: string[]; json?: boolean } = {},
): void {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka pack list-recipes <name>")
	const cwd = opts.cwd ?? process.cwd()
	// Resolve through the same registry the engine uses so list-recipes sees
	// the same packs plan/apply/validate see (tree, project marketplace,
	// user marketplace, bundled), not just the in-tree packs/ dir.
	const root = new PackRegistry(cwd, { packDirs: opts.packDirs }).resolvePackRoot(name)
	if (!root) {
		const msg = `pack not found: ${name} (searched tree, project marketplace, user marketplace, and bundled scopes)`
		if (opts.json) {
			console.log(JSON.stringify({ pack: name, error: msg }, null, 2))
			process.exit(BAKA_EXIT_CODE.USER_ERROR)
		}
		die(BAKA_EXIT_CODE.USER_ERROR, msg)
	}
	const manifestPath = join(root, "manifest.ts")

	let mod: { Manifest?: PackManifest }
	try {
		const jiti = createJiti(root)
		mod = jiti(manifestPath) as { Manifest?: PackManifest }
	} catch (err) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `failed to load manifest: ${err instanceof Error ? err.message : String(err)}`)
	}
	if (!mod.Manifest) die(BAKA_EXIT_CODE.ENGINE_ERROR, "manifest.ts did not export a Manifest")
	const m = mod.Manifest
	if (opts.json) {
		// Same shape as the MCP `baka_list_recipes` tool output.
		console.log(
			JSON.stringify(
				{
					pack: m.name,
					version: m.version,
					description: m.description,
					recipes: m.recipes.map((a) => ({
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
	console.log(`pack: ${m.name} v${m.version}`)
	if (m.description) console.log(`  ${m.description}`)
	console.log(`  ${m.recipes.length} recipe(s):`)
	for (const a of m.recipes) {
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
// `baka pack edit <name>`
// ---------------------------------------------------------------------------

export async function runPackEdit(name: string, opts: { cwd?: string; packDirs?: string[] } = {}): Promise<void> {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka pack edit <name>")
	const editorCmd = process.env.EDITOR
	if (!editorCmd) die(BAKA_EXIT_CODE.USER_ERROR, "no $EDITOR set")
	const cwd = opts.cwd ?? process.cwd()
	// Resolve through the same registry the engine uses so edit opens the
	// pack plan/apply/validate see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree packs/ dir.
	const root = new PackRegistry(cwd, { packDirs: opts.packDirs }).resolvePackRoot(name)
	if (!root) die(BAKA_EXIT_CODE.USER_ERROR, `pack not found: ${name}`)
	const manifestPath = join(root, "manifest.ts")

	const child = spawn(editorCmd, [manifestPath], { stdio: "inherit" })
	await new Promise<void>((resolveProm) => {
		child.on("exit", () => resolveProm())
	})

	// Re-validate after edit
	runPackValidate(name, { cwd, packDirs: opts.packDirs })
}

// ---------------------------------------------------------------------------
// `baka pack test <name> --recipe=<id> --input=<json>`
// Runs the recipe in a clean temp dir, prints before/after tree, and runs
// the pack's validators.
// ---------------------------------------------------------------------------

export async function runPackTest(
	name: string,
	recipeId: string,
	inputJson: string,
	opts: { cwd?: string; packDirs?: string[] } = {},
): Promise<void> {
	if (!name) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka pack test <name> --recipe=<id> [--input=<json>]")
	if (!recipeId) die(BAKA_EXIT_CODE.USER_ERROR, "--recipe=<id> is required")

	const cwd = opts.cwd ?? process.cwd()
	// Resolve through the same registry the engine uses so `pack test`
	// sees the same packs plan/apply see (tree, project marketplace, user
	// marketplace, bundled), not just the in-tree packs/ dir.
	const resolved = new PackRegistry(cwd, { packDirs: opts.packDirs }).resolvePackRoot(name)
	if (!resolved) die(BAKA_EXIT_CODE.USER_ERROR, `pack not found: ${name}`)
	// Marketplace installs are symlinks; copy the real directory so the
	// recipe's writes land in the temp copy, never in the installed source.
	const root = realpathSync(resolved)

	const hasRecipe = existsSync(join(root, recipeId, "recipe.ts"))
	const hasTemplates = existsSync(join(root, recipeId, "templates"))
	if (!hasRecipe && !hasTemplates) {
		die(
			BAKA_EXIT_CODE.USER_ERROR,
			`recipe "${recipeId}" not found (no ${recipeId}/recipe.ts or ${recipeId}/templates/ in pack ${name})`,
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

	const tempDir = join(tmpdir(), `baka-test-${name}-${recipeId}-${Date.now()}`)
	mkdirSync(join(tempDir, "packs"), { recursive: true })
	writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "baka-pack-test", private: true }))
	const packCopy = join(tempDir, "packs", name)
	cpSync(root, packCopy, { recursive: true })

	console.log(`running ${name}:${recipeId} in ${tempDir}`)
	console.log(`  input: ${JSON.stringify(parsedInput)}`)
	console.log("")

	let exitCode: number = BAKA_EXIT_CODE.SUCCESS
	try {
		const result = await runRecipe({
			registry: new PackRegistry(tempDir),
			pack: name,
			recipe: recipeId,
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
