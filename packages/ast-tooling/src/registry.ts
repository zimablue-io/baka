import { type Dirent, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
	BAKA_PROJECT_PATHS,
	bakaHomeDir,
	type PackManifest,
	PackManifestSchema,
	type ValidationDiagnostic,
	type ValidationResult,
} from "@repo/protocol"
import { createJiti } from "jiti"

/**
 * Convert a camelCase validator id (e.g. "hasPackageJson") to its kebab-case
 * filename stem (e.g. "has-package-json"). Validator ids stay camelCase in
 * manifests (matching JS function names) but live as kebab-case .ts files
 * on disk (matching the codebase's filename convention).
 *
 * Exported because sibling tooling (e.g. `apps/cli/src/commands/pack.ts`)
 * needs to resolve validator filenames when reading manifests directly.
 * Keeping the conversion in one place ensures registry-side and CLI-side
 * checks agree on the path.
 */
export function validatorFilename(id: string): string {
	return id.replace(/[A-Z]/g, (m, offset) => (offset > 0 ? "-" : "") + m.toLowerCase())
}

export interface PackRegistryOptions {
	/**
	 * Explicit pack directories, highest precedence first. Each directory
	 * contains `<pack-name>/manifest.ts` entries. When given, ONLY these
	 * directories are searched: the in-tree `packs/`, the project
	 * marketplace, the user marketplace (`${BAKA_HOME:-$HOME/.baka}`), and the
	 * bundled scope are all skipped, so discovery never reads process-global
	 * state. Relative paths resolve against `root`.
	 */
	packDirs?: readonly string[]
}

type ScopeName = "tree" | "project" | "user" | "bundled" | "explicit"

interface SearchScope {
	dir: string
	scope: ScopeName
	jitiRoot: string
}

export class PackRegistry {
	private readonly byName = new Map<string, { manifest: PackManifest; packRoot: string }>()
	/** The project root: where recipes write, and where `packs/` and `.baka/` are looked up. */
	readonly root: string
	private readonly packDirs: readonly string[] | undefined

	constructor(root: string, options: PackRegistryOptions = {}) {
		this.root = resolve(root)
		this.packDirs = options.packDirs?.map((dir) => resolve(this.root, dir))
	}

	/**
	 * Bundled packs ship next to an installed CLI, not by walking the
	 * git checkout. Walking up from this file used to inject the repo's
	 * example packs into every project that had a package.json.
	 */
	private static findBundledPacksDir(): string | null {
		return null
	}

	/**
	 * The pack search scopes in precedence order (highest first): the
	 * project marketplace, in-tree packs, the user marketplace, then the
	 * bundled scope (the baka repo's own packs/, when reachable). The
	 * first scope that provides a pack name owns it; lower-precedence
	 * copies are skipped. With explicit `packDirs` the list is exactly
	 * those directories, in the order given.
	 */
	private searchScopes(): SearchScope[] {
		if (this.packDirs) {
			return this.packDirs.map((dir) => ({ dir, scope: "explicit", jitiRoot: dirname(dir) }))
		}
		const scopes: SearchScope[] = [
			{ dir: join(this.root, BAKA_PROJECT_PATHS.ROOT, "packs"), scope: "project", jitiRoot: this.root },
			{ dir: join(this.root, "packs"), scope: "tree", jitiRoot: this.root },
			{ dir: join(bakaHomeDir(), "packs"), scope: "user", jitiRoot: this.root },
		]
		const bundledDir = PackRegistry.findBundledPacksDir()
		if (bundledDir) {
			// jiti needs to resolve `baka-sdk` from the bundled pack's
			// own `node_modules/` symlink; the baka repo root is the
			// natural lookup root for that.
			scopes.push({ dir: bundledDir, scope: "bundled", jitiRoot: dirname(bundledDir) })
		}
		return scopes
	}

	/**
	 * Resolve the on-disk root of a single named pack across every scope,
	 * without parsing its manifest. Precedence mirrors discover()'s dedup
	 * rules: project marketplace wins, then tree, then user marketplace,
	 * then bundled. Unlike discover(), the bundled scope is always probed:
	 * resolving an explicitly-named pack (e.g. a plan step's target) is
	 * not gated on the cwd looking like a project.
	 */
	resolvePackRoot(name: string): string | undefined {
		for (const scope of this.searchScopes()) {
			const candidate = join(scope.dir, name)
			if (existsSync(join(candidate, "manifest.ts"))) {
				return candidate
			}
		}
		return undefined
	}

	/**
	 * Discover and validate every pack under <root>/packs/*.
	 * A pack must have:
	 *   - manifest.ts exporting a `Manifest` value of type PackManifest
	 *   - one folder per declared recipe, containing templates/ and/or recipe.ts
	 * Layout errors are collected and reported; we do not throw on a single
	 * bad pack unless `strict` is true.
	 */
	discover(strict = false): { packs: PackManifest[]; diagnostics: ValidationDiagnostic[] } {
		this.byName.clear()
		const diagnostics: ValidationDiagnostic[] = []

		// Walk the scopes in precedence order (project marketplace, tree,
		// user marketplace, bundled); the first scope to provide a pack
		// name owns it, so the project marketplace deterministically wins
		// on dedup. The bundled scope (the baka repo's in-tree packs) is
		// listed only when the baka repo is reachable AND the cwd looks
		// like a real project (has a package.json). The package.json gate
		// keeps the bundled scope silent in truly empty directories; without
		// it, `baka list-packs` from `/tmp` would silently return the
		// bundled packs, breaking the cwd-scoped discovery invariant.
		const bundledEnabled = existsSync(join(this.root, "package.json"))

		let anyFound = false
		for (const scope of this.searchScopes()) {
			if (scope.scope === "bundled" && !bundledEnabled) continue
			const { dir, jitiRoot } = scope
			if (!existsSync(dir)) continue
			anyFound = true
			let entries: Dirent[]
			try {
				entries = readdirSync(dir, { withFileTypes: true })
			} catch (err) {
				diagnostics.push({
					severity: "warning",
					rule: "scope-unreadable",
					message: `cannot read packs dir ${dir}: ${err instanceof Error ? err.message : String(err)}; skipping scope`,
				})
				continue
			}
			// Sort entries so discovery output (packs and diagnostics) is
			// byte-identical across runs regardless of readdir order.
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
			for (const entry of entries) {
				// Accept real directories and symlinks (so marketplace installs
				// can symlink to a local pack on disk).
				if (!(entry.isDirectory() || entry.isSymbolicLink())) continue
				// A higher-precedence scope already owns this name.
				if (this.byName.has(entry.name)) continue
				const packRoot = join(dir, entry.name)
				const manifestPath = join(packRoot, "manifest.ts")
				if (!existsSync(manifestPath)) {
					diagnostics.push({
						severity: "warning",
						rule: "manifest-missing",
						pack: entry.name,
						message: `${entry.name} (${packRoot}) has no manifest.ts; skipping`,
					})
					continue
				}

				let rawManifest: unknown
				try {
					const jiti = createJiti(jitiRoot, { interopDefault: true })
					const mod = jiti(manifestPath) as { Manifest?: unknown }
					rawManifest = mod.Manifest
				} catch (err) {
					diagnostics.push({
						severity: "error",
						rule: "manifest-load",
						pack: entry.name,
						message: `${entry.name} (${manifestPath}): failed to load manifest.ts: ${err instanceof Error ? err.message : String(err)}`,
					})
					if (strict) throw err
					continue
				}

				if (!rawManifest) {
					diagnostics.push({
						severity: "error",
						rule: "manifest-export",
						pack: entry.name,
						message: `${entry.name} (${manifestPath}): manifest.ts did not export \`Manifest\``,
					})
					if (strict) throw new Error(diagnostics[diagnostics.length - 1].message)
					continue
				}

				const parsed = PackManifestSchema.safeParse(rawManifest)
				if (!parsed.success) {
					diagnostics.push({
						severity: "error",
						rule: "manifest-shape",
						pack: entry.name,
						message: `${entry.name} (${manifestPath}): manifest does not match schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
					})
					if (strict) throw new Error(parsed.error.message)
					continue
				}

				// The manifest's declared name (not the directory name) is the
				// dedup key; a higher-precedence scope may own it already.
				if (this.byName.has(parsed.data.name)) continue

				// Layout enforcement (per spec section 4)
				for (const recipe of parsed.data.recipes) {
					const recipeTs = join(packRoot, recipe.id, "recipe.ts")
					const templatesDir = join(packRoot, recipe.id, "templates")
					if (!existsSync(recipeTs) && !existsSync(templatesDir)) {
						diagnostics.push({
							severity: "error",
							rule: "recipe-missing",
							pack: entry.name,
							message: `${entry.name}: recipe "${recipe.id}" is missing ${recipe.id}/recipe.ts and ${recipe.id}/templates/`,
						})
					}
					if (recipe.requiresReasoning) {
						const tpl = join(packRoot, recipe.id, "templates")
						if (!existsSync(tpl)) {
							diagnostics.push({
								severity: "error",
								rule: "templates-missing",
								pack: entry.name,
								message: `${entry.name}: recipe "${recipe.id}" has requiresReasoning: true but no templates/ folder`,
							})
						}
					}
					for (const ruleId of recipe.validators ?? []) {
						const rulePath = join(packRoot, recipe.id, "validators", `${validatorFilename(ruleId)}.ts`)
						if (!existsSync(rulePath)) {
							diagnostics.push({
								severity: "error",
								rule: "recipe-validator-missing",
								pack: entry.name,
								message: `${entry.name}: recipe "${recipe.id}" declares validator "${ruleId}" but ${recipe.id}/validators/${validatorFilename(ruleId)}.ts does not exist`,
							})
						}
					}
				}

				this.byName.set(parsed.data.name, { manifest: parsed.data, packRoot })
			}
		}

		// Rebuild byName in name-sorted order so every consumer (all(),
		// the returned packs array, resolveOrder's iteration) sees a
		// deterministic, byte-identical ordering across runs.
		const sorted = Array.from(this.byName.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		this.byName.clear()
		for (const [name, value] of sorted) this.byName.set(name, value)

		if (!anyFound) {
			diagnostics.push({
				severity: "warning",
				rule: "no-packs",
				message: `no packs found in any scope (tree, project marketplace, user marketplace, or bundled)`,
			})
		}

		return { packs: this.all(), diagnostics }
	}

	/**
	 * Recipe ids exported by more than one discovered pack, mapped to the
	 * sorted list of owning pack names. An id owned by the SAME pack in
	 * multiple scopes is not a collision (scope dedup has already resolved
	 * it). Used by plan-time refusal (architecture decision 12): a plan
	 * referencing a colliding id would be ambiguous about which pack's
	 * recipe to run.
	 */
	recipeIdCollisions(): Map<string, string[]> {
		const owners = new Map<string, Set<string>>()
		for (const { manifest } of this.byName.values()) {
			for (const recipe of manifest.recipes) {
				const set = owners.get(recipe.id) ?? new Set<string>()
				set.add(manifest.name)
				owners.set(recipe.id, set)
			}
		}
		const collisions = new Map<string, string[]>()
		for (const [recipeId, packs] of owners) {
			if (packs.size > 1) {
				collisions.set(
					recipeId,
					Array.from(packs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
				)
			}
		}
		return collisions
	}

	findByName(name: string): PackManifest | undefined {
		return this.byName.get(name)?.manifest
	}

	packRootFor(name: string): string | undefined {
		return this.byName.get(name)?.packRoot
	}

	all(): PackManifest[] {
		return Array.from(this.byName.values()).map((entry) => entry.manifest)
	}

	/**
	 * Topological sort of packs by their `dependencies` field. Returns the
	 * install order. Throws if a cycle is detected or a dependency is missing.
	 */
	resolveOrder(): PackManifest[] {
		const visited = new Set<string>()
		const visiting = new Set<string>()
		const result: PackManifest[] = []
		const visit = (m: PackManifest) => {
			if (visited.has(m.name)) return
			if (visiting.has(m.name)) throw new Error(`dependency cycle detected at ${m.name}`)
			visiting.add(m.name)
			for (const dep of m.dependencies) {
				const found = this.byName.get(dep)?.manifest
				if (!found) throw new Error(`pack ${m.name} depends on ${dep}, which is not installed`)
				visit(found)
			}
			visiting.delete(m.name)
			visited.add(m.name)
			result.push(m)
		}
		for (const entry of this.byName.values()) visit(entry.manifest)
		return result
	}

	/**
	 * Run all pack-level validators and return a ValidationResult.
	 * Layout errors are folded in as well.
	 */
	validate(): ValidationResult {
		const diagnostics: ValidationDiagnostic[] = []
		for (const entry of this.byName.values()) {
			const m = entry.manifest
			const packRoot = entry.packRoot
			for (const ruleId of m.packValidators) {
				const rulePath = join(packRoot, "_shared", "validators", `${validatorFilename(ruleId)}.ts`)
				if (!existsSync(rulePath)) {
					diagnostics.push({
						severity: "error",
						rule: ruleId,
						message: `${m.name}: validator ${ruleId} not found at ${rulePath}`,
					})
				}
			}
			// Recipe-level validator existence check (the runner that actually
			// executes them is `runValidators` in ./validator.ts; this method
			// only does structural checks).
			for (const recipe of m.recipes) {
				for (const ruleId of recipe.validators ?? []) {
					const rulePath = join(packRoot, recipe.id, "validators", `${validatorFilename(ruleId)}.ts`)
					if (!existsSync(rulePath)) {
						diagnostics.push({
							severity: "error",
							rule: `${m.name}:${recipe.id}:${ruleId}`,
							message: `${m.name}: recipe "${recipe.id}" declares validator "${ruleId}" but ${recipe.id}/validators/${validatorFilename(ruleId)}.ts does not exist`,
						})
					}
				}
			}
		}
		return { kind: diagnostics.some((d) => d.severity === "error") ? "fail" : "pass", diagnostics }
	}
}
