import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Local bare-git fixture for publish-endpoint tests (architecture
 * §4.5 / §6). The validation contract uses real GitHub repos for
 * the fixture repos (FIXTURE_OK_REPO etc.), but the registry's
 * hermetic tests should not depend on network access — the mission
 * readiness summary explicitly calls out "unauthenticated API limit
 * 60/h" as the reason to prefer local bare repos in tmp dirs.
 *
 * Each fixture creates a bare source repo, a working tree that
 * commits the manifest at a given tag, and exposes the source URL
 * (the `file://` path to the bare repo) for the publish endpoint
 * to clone. Cleanup removes both the bare repo and the working
 * tree on `close()`.
 *
 * Usage:
 *   const fx = await createGitFixture()
 *   await fx.commitManifest({
 *     name: "my-mod",
 *     version: "1.0.0",
 *     description: "...",
 *   }, "v1.0.0")
 *   const repoUrl = fx.bareUrl
 *   // ... publish against `repoUrl` ...
 *   await fx.cleanup()
 */

export interface GitFixture {
	/** file:// URL pointing at the bare repository. */
	bareUrl: string
	/** Absolute path to the working tree (post-clone). */
	workDir: string
	/**
	 * Commits `manifestSource` at the repo root (or under
	 * `packPath` when supplied) at the given `tag`. The
	 * commit is the only content the publish endpoint will
	 * see.
	 */
	commitManifest: (args: {
		name: string
		version: string
		description?: string
		dependencies?: string[]
		recipes?: Array<{
			id: string
			description?: string
			filePatterns?: string[]
			requiresReasoning?: boolean
			validators?: string[]
			toolchain?: "tsc"
			/** When `true` (default), the fixture writes a loadable
			 *  `recipe.ts` file. When `false`, the recipe's
			 *  `recipe.ts` exists but has no WorkflowStep export —
			 *  the loadability gate fails on the resolution-order
			 *  check at the loader level (VAL-PUB-014 fixture,
			 *  scrutiny-round-1 fix). */
			loadable?: boolean
			/** Optional source body for `<id>/recipe.ts`. When set,
			 *  the fixture writes this verbatim instead of the
			 *  default loadable body. Used by the dry-run tests
			 *  to drop fixture-specific source (canary escapes,
			 *  infinite loops, file writers) without polluting
			 *  every other consumer of `commitManifest`. */
			body?: string
		}>
		packValidators?: string[]
		packPath?: string
		tag: string
		manifestFormat?: "ts" | "json"
		/**
		 * Extra files written under the pack root before commit.
		 * Paths are relative to the pack root (NOT the repo root)
		 * when `packPath` is set, matching the manifest layout the
		 * worker reads. Used by the screening tests to drop fixture
		 * files that exercise specific AST detection rules.
		 */
		extras?: Array<{ path: string; content: string }>
	}) => Promise<{ commitSha: string }>
	cleanup: () => Promise<void>
}

function exec(args: { cmd: string; args: string[]; cwd?: string }): string {
	const result = execFileSync(args.cmd, args.args, {
		cwd: args.cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})
	return result.trim()
}

function manifestSource(opts: {
	name: string
	version: string
	description?: string
	dependencies?: string[]
	recipes?: Array<{
		id: string
		description?: string
		filePatterns?: string[]
		requiresReasoning?: boolean
		validators?: string[]
		toolchain?: "tsc"
	}>
	packValidators?: string[]
}): string {
	const description = opts.description ?? `pack ${opts.name}`
	const dependencies = opts.dependencies ?? []
	const recipes = opts.recipes ?? [
		{
			id: "noop",
			description: "no-op recipe",
			filePatterns: [],
			requiresReasoning: false,
		},
	]
	const renderedRecipes = recipes
		.map((a) => {
			const toolchainField = a.toolchain ? `, toolchain: ${JSON.stringify(a.toolchain)}` : ""
			return `    { id: ${JSON.stringify(a.id)}, description: ${JSON.stringify(a.description ?? "")}, params: [], requiresReasoning: ${a.requiresReasoning ? "true" : "false"}, filePatterns: ${JSON.stringify(a.filePatterns ?? [])}, validators: ${JSON.stringify(a.validators ?? [])}${toolchainField} }`
		})
		.join(",\n")
	const renderedDeps = dependencies.map((d) => JSON.stringify(d)).join(", ")
	const renderedPackValidators = (opts.packValidators ?? []).map((v) => JSON.stringify(v)).join(", ")
	return `export default {
  name: ${JSON.stringify(opts.name)},
  version: ${JSON.stringify(opts.version)},
  description: ${JSON.stringify(description)},
  dependencies: [${renderedDeps}],
  conflictsWith: [],
  recipes: [
${renderedRecipes}
  ],
  packValidators: [${renderedPackValidators}],
} satisfies never
`
}

export async function createGitFixture(): Promise<GitFixture> {
	const baseDir = await mkdtemp(join(tmpdir(), "baka-git-fixture-"))
	const bareDir = join(baseDir, "bare.git")
	const workDir = join(baseDir, "work")
	await mkdir(bareDir, { recursive: true })
	await mkdir(workDir, { recursive: true })

	exec({ cmd: "git", args: ["init", "--bare", bareDir] })
	// Ensure HEAD points at the default branch name so shallow
	// clones don't trip a "unknown revision" warning.
	exec({ cmd: "git", args: ["--git-dir", bareDir, "symbolic-ref", "HEAD", "refs/heads/main"] })

	// Initialize the working tree as a normal repo and add the
	// bare repo as its `origin` so `git push` works.
	exec({ cmd: "git", args: ["init", "-b", "main", workDir] })
	exec({ cmd: "git", args: ["-C", workDir, "remote", "add", "origin", bareDir] })

	// Set up a minimal local user identity so commits succeed.
	// The values are pinned to the fixture's life — no real
	// operator identity is leaked.
	try {
		exec({ cmd: "git", args: ["-C", workDir, "config", "user.email", "fixture@baka.local"] })
		exec({ cmd: "git", args: ["-C", workDir, "config", "user.name", "baka-fixture"] })
	} catch {
		// ignore — local-only
	}

	return {
		bareUrl: bareDir.startsWith("/") ? `file://${bareDir}` : `file:///${bareDir.replace(/\\/g, "/")}`,
		workDir,
		async commitManifest(opts) {
			const packPath = opts.packPath ?? ""
			const targetDir = packPath.length > 0 ? join(workDir, packPath) : workDir
			await mkdir(targetDir, { recursive: true })
			const sourceExt = opts.manifestFormat ?? "ts"
			const filename = sourceExt === "json" ? "manifest.json" : "manifest.ts"
			const body =
				sourceExt === "json" ? `${JSON.stringify(manifestToJsonShape(opts), null, 2)}\n` : manifestSource(opts)
			await writeFile(join(targetDir, filename), body, "utf8")

			// Write a loadable recipe.ts for every declared recipe
			// (including the implicit default `noop`). The exported
			// shape is the engine's WorkflowStep contract (execute +
			// compensate functions); the loadability gate in the
			// worker pins VAL-PUB-014 (an unloadable recipe fails the
			// version with a diagnostic naming the id).
			//
			// When `loadable: false` is set on a specific recipe, the
			// directory is created and the recipe.ts FILE is written,
			// but its export set is empty — the loadability gate
			// fails on the resolution-order check at the loader level
			// (the contract's stated intent: "the file exists in the
			// repo; it fails to import"). This is the truthful failure
			// mode for VAL-PUB-014; the previous "no file written"
			// fixture tripped the pathExists check instead.
			const declaredRecipes = opts.recipes ?? [
				{ id: "noop", description: "no-op recipe", filePatterns: [], requiresReasoning: false },
			]
			for (const recipe of declaredRecipes) {
				const loadable = recipe.loadable !== false
				const recipeDir = join(targetDir, recipe.id)
				await mkdir(recipeDir, { recursive: true })
				if (recipe.body !== undefined) {
					// Custom body: drop the fixture author's source
					// verbatim. Used by the dry-run tests (canary
					// escapes, infinite loops, file writers). The
					// `loadable` flag is irrelevant — a custom body
					// is presumed loadable by its author.
					await writeFile(join(recipeDir, "recipe.ts"), recipe.body, "utf8")
				} else if (loadable) {
					const recipeSource = loadableRecipeSource(recipe.id)
					await writeFile(join(recipeDir, "recipe.ts"), recipeSource, "utf8")
				} else {
					// File EXISTS (so the pathExists check at the
					// top of the loadability gate does NOT trip), but
					// the export set is empty — none of the resolution-
					// order candidates (camelCase(id), camelCase(id)+
					// "Recipe", exact id, id+"Recipe", "default") is
					// a WorkflowStep, so the gate's loader-resolution
					// branch fails.
					await writeFile(
						join(recipeDir, "recipe.ts"),
						`// Intentionally unloadable: the file exists so the gate's\n// pathExists check passes, but the export set has no\n// WorkflowStep-shaped symbol — the loadability gate fails on\n// the resolution-order check, naming the recipe id.\nexport const somethingElse = "not-a-workflow-step";\n`,
						"utf8",
					)
				}
			}

			// Optional extra files (screening tests use these to drop
			// fixture content that exercises specific AST detection
			// rules — e.g. a Handlebars template, a sub-recipe.ts
			// containing `fetch(`, etc.). Paths are relative to the
			// pack root when `packPath` is set, matching the
			// manifest layout the worker reads. The `git add`
			// step below turns each into a repo-root-relative path.
			for (const extra of opts.extras ?? []) {
				const fullPath = join(targetDir, extra.path)
				const parentDir = join(fullPath, "..")
				await mkdir(parentDir, { recursive: true })
				await writeFile(fullPath, extra.content, "utf8")
			}

			// `git add` takes paths relative to the repo root.
			// `manifest.ts` lives under `packPath` when set, so
			// the relative path is `${packPath}/${filename}`. Each
			// recipe dir is added the same way.
			const relativePaths: string[] = []
			const manifestRel = packPath.length > 0 ? `${packPath}/${filename}` : filename
			relativePaths.push(manifestRel)
			for (const recipe of declaredRecipes) {
				relativePaths.push(packPath.length > 0 ? `${packPath}/${recipe.id}` : recipe.id)
			}
			for (const extra of opts.extras ?? []) {
				relativePaths.push(packPath.length > 0 ? `${packPath}/${extra.path}` : extra.path)
			}
			exec({ cmd: "git", args: ["-C", workDir, "add", "--", ...relativePaths] })

			exec({ cmd: "git", args: ["-C", workDir, "commit", "-m", `manifest for ${opts.tag}`] })
			exec({ cmd: "git", args: ["-C", workDir, "tag", opts.tag] })
			exec({ cmd: "git", args: ["-C", workDir, "push", "origin", opts.tag] })
			exec({ cmd: "git", args: ["-C", workDir, "push", "origin", "HEAD:refs/heads/main"] })
			const commitSha = exec({ cmd: "git", args: ["-C", workDir, "rev-parse", "HEAD"] })
			return { commitSha }
		},
		async cleanup() {
			await rm(baseDir, { recursive: true, force: true }).catch(() => {})
		},
	}
}

function manifestToJsonShape(opts: {
	name: string
	version: string
	description?: string
	dependencies?: string[]
	recipes?: Array<{
		id: string
		description?: string
		filePatterns?: string[]
		requiresReasoning?: boolean
		validators?: string[]
		toolchain?: "tsc"
	}>
	packValidators?: string[]
}): Record<string, unknown> {
	const renderedRecipes = (opts.recipes ?? []).map((a) => ({
		id: a.id,
		description: a.description ?? "",
		params: [],
		requiresReasoning: a.requiresReasoning ?? false,
		filePatterns: a.filePatterns ?? [],
		validators: a.validators ?? [],
		...(a.toolchain ? { toolchain: a.toolchain } : {}),
	}))
	return {
		name: opts.name,
		version: opts.version,
		description: opts.description ?? `pack ${opts.name}`,
		dependencies: opts.dependencies ?? [],
		conflictsWith: [],
		recipes:
			renderedRecipes.length > 0
				? renderedRecipes
				: [
						{
							id: "noop",
							description: "no-op recipe",
							params: [],
							requiresReasoning: false,
							filePatterns: [],
							validators: [],
						},
					],
		packValidators: opts.packValidators ?? [],
	}
}

/**
 * Minimal but VALID WorkflowStep shape. The default export matches
 * the engine's resolution order (`default` is the last candidate;
 * a named export like `${camelCase}Recipe` would resolve earlier
 * but the default is always honored). The execute / compensate
 * bodies are no-ops — the loadability gate only imports the file,
 * it does not invoke the recipes.
 */
function loadableRecipeSource(recipeId: string): string {
	return `export default {
  name: ${JSON.stringify(recipeId)},
  role: 1,
  async execute() {
    return { success: true, output: undefined, compensationData: undefined }
  },
  async compensate() {
    // no-op
  },
}
`
}
