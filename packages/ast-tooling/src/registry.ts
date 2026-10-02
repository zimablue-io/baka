import { type Dirent, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
	BAKA_PROJECT_PATHS,
	bakaHomeDir,
	type ModuleManifest,
	ModuleManifestSchema,
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
 * Exported because sibling tooling (e.g. `apps/cli/src/commands/module.ts`)
 * needs to resolve validator filenames when reading manifests directly.
 * Keeping the conversion in one place ensures registry-side and CLI-side
 * checks agree on the path.
 */
export function validatorFilename(id: string): string {
	return id.replace(/[A-Z]/g, (m, offset) => (offset > 0 ? "-" : "") + m.toLowerCase())
}

export interface ModuleRegistryOptions {
	/**
	 * Explicit module directories, highest precedence first. Each directory
	 * contains `<module-name>/manifest.ts` entries. When given, ONLY these
	 * directories are searched: the in-tree `modules/`, the project
	 * marketplace, the user marketplace (`${BAKA_HOME:-$HOME/.baka}`), and the
	 * bundled scope are all skipped, so discovery never reads process-global
	 * state. Relative paths resolve against `root`.
	 */
	moduleDirs?: readonly string[]
}

type ScopeName = "tree" | "project" | "user" | "bundled" | "explicit"

interface SearchScope {
	dir: string
	scope: ScopeName
	jitiRoot: string
}

export class ModuleRegistry {
	private readonly byName = new Map<string, { manifest: ModuleManifest; moduleRoot: string }>()
	/** The project root: where actions write, and where `modules/` and `.baka/` are looked up. */
	readonly root: string
	private readonly moduleDirs: readonly string[] | undefined

	constructor(root: string, options: ModuleRegistryOptions = {}) {
		this.root = resolve(root)
		this.moduleDirs = options.moduleDirs?.map((dir) => resolve(this.root, dir))
	}

	/**
	 * Bundled modules ship next to an installed CLI, not by walking the
	 * git checkout. Walking up from this file used to inject the repo's
	 * example modules into every project that had a package.json.
	 */
	private static findBundledModulesDir(): string | null {
		return null
	}

	/**
	 * The module search scopes in precedence order (highest first): the
	 * project marketplace, in-tree modules, the user marketplace, then the
	 * bundled scope (the baka repo's own modules/, when reachable). The
	 * first scope that provides a module name owns it; lower-precedence
	 * copies are skipped. With explicit `moduleDirs` the list is exactly
	 * those directories, in the order given.
	 */
	private searchScopes(): SearchScope[] {
		if (this.moduleDirs) {
			return this.moduleDirs.map((dir) => ({ dir, scope: "explicit", jitiRoot: dirname(dir) }))
		}
		const scopes: SearchScope[] = [
			{ dir: join(this.root, BAKA_PROJECT_PATHS.ROOT, "modules"), scope: "project", jitiRoot: this.root },
			{ dir: join(this.root, "modules"), scope: "tree", jitiRoot: this.root },
			{ dir: join(bakaHomeDir(), "modules"), scope: "user", jitiRoot: this.root },
		]
		const bundledDir = ModuleRegistry.findBundledModulesDir()
		if (bundledDir) {
			// jiti needs to resolve `baka-sdk` from the bundled module's
			// own `node_modules/` symlink; the baka repo root is the
			// natural lookup root for that.
			scopes.push({ dir: bundledDir, scope: "bundled", jitiRoot: dirname(bundledDir) })
		}
		return scopes
	}

	/**
	 * Resolve the on-disk root of a single named module across every scope,
	 * without parsing its manifest. Precedence mirrors discover()'s dedup
	 * rules: project marketplace wins, then tree, then user marketplace,
	 * then bundled. Unlike discover(), the bundled scope is always probed:
	 * resolving an explicitly-named module (e.g. a plan step's target) is
	 * not gated on the cwd looking like a project.
	 */
	resolveModuleRoot(name: string): string | undefined {
		for (const scope of this.searchScopes()) {
			const candidate = join(scope.dir, name)
			if (existsSync(join(candidate, "manifest.ts"))) {
				return candidate
			}
		}
		return undefined
	}

	/**
	 * Discover and validate every module under <root>/modules/*.
	 * A module must have:
	 *   - manifest.ts exporting a `Manifest` value of type ModuleManifest
	 *   - one folder per declared action, containing templates/ and/or action.ts
	 * Layout errors are collected and reported; we do not throw on a single
	 * bad module unless `strict` is true.
	 */
	discover(strict = false): { modules: ModuleManifest[]; diagnostics: ValidationDiagnostic[] } {
		this.byName.clear()
		const diagnostics: ValidationDiagnostic[] = []

		// Walk the scopes in precedence order (project marketplace, tree,
		// user marketplace, bundled); the first scope to provide a module
		// name owns it, so the project marketplace deterministically wins
		// on dedup. The bundled scope (the baka repo's in-tree modules) is
		// listed only when the baka repo is reachable AND the cwd looks
		// like a real project (has a package.json). The package.json gate
		// keeps the bundled scope silent in truly empty directories; without
		// it, `baka list-modules` from `/tmp` would silently return the
		// bundled modules, breaking the cwd-scoped discovery invariant.
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
					message: `cannot read modules dir ${dir}: ${err instanceof Error ? err.message : String(err)}; skipping scope`,
				})
				continue
			}
			// Sort entries so discovery output (modules and diagnostics) is
			// byte-identical across runs regardless of readdir order.
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
			for (const entry of entries) {
				// Accept real directories and symlinks (so marketplace installs
				// can symlink to a local module on disk).
				if (!(entry.isDirectory() || entry.isSymbolicLink())) continue
				// A higher-precedence scope already owns this name.
				if (this.byName.has(entry.name)) continue
				const moduleRoot = join(dir, entry.name)
				const manifestPath = join(moduleRoot, "manifest.ts")
				if (!existsSync(manifestPath)) {
					diagnostics.push({
						severity: "warning",
						rule: "manifest-missing",
						module: entry.name,
						message: `${entry.name} (${moduleRoot}) has no manifest.ts; skipping`,
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
						module: entry.name,
						message: `${entry.name} (${manifestPath}): failed to load manifest.ts: ${err instanceof Error ? err.message : String(err)}`,
					})
					if (strict) throw err
					continue
				}

				if (!rawManifest) {
					diagnostics.push({
						severity: "error",
						rule: "manifest-export",
						module: entry.name,
						message: `${entry.name} (${manifestPath}): manifest.ts did not export \`Manifest\``,
					})
					if (strict) throw new Error(diagnostics[diagnostics.length - 1].message)
					continue
				}

				const parsed = ModuleManifestSchema.safeParse(rawManifest)
				if (!parsed.success) {
					diagnostics.push({
						severity: "error",
						rule: "manifest-shape",
						module: entry.name,
						message: `${entry.name} (${manifestPath}): manifest does not match schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
					})
					if (strict) throw new Error(parsed.error.message)
					continue
				}

				// The manifest's declared name (not the directory name) is the
				// dedup key; a higher-precedence scope may own it already.
				if (this.byName.has(parsed.data.name)) continue

				// Layout enforcement (per spec section 4)
				for (const action of parsed.data.actions) {
					const actionTs = join(moduleRoot, action.id, "action.ts")
					const templatesDir = join(moduleRoot, action.id, "templates")
					if (!existsSync(actionTs) && !existsSync(templatesDir)) {
						diagnostics.push({
							severity: "error",
							rule: "action-missing",
							module: entry.name,
							message: `${entry.name}: action "${action.id}" is missing ${action.id}/action.ts and ${action.id}/templates/`,
						})
					}
					if (action.requiresReasoning) {
						const tpl = join(moduleRoot, action.id, "templates")
						if (!existsSync(tpl)) {
							diagnostics.push({
								severity: "error",
								rule: "templates-missing",
								module: entry.name,
								message: `${entry.name}: action "${action.id}" has requiresReasoning: true but no templates/ folder`,
							})
						}
					}
					for (const ruleId of action.validators ?? []) {
						const rulePath = join(moduleRoot, action.id, "validators", `${validatorFilename(ruleId)}.ts`)
						if (!existsSync(rulePath)) {
							diagnostics.push({
								severity: "error",
								rule: "action-validator-missing",
								module: entry.name,
								message: `${entry.name}: action "${action.id}" declares validator "${ruleId}" but ${action.id}/validators/${validatorFilename(ruleId)}.ts does not exist`,
							})
						}
					}
				}

				this.byName.set(parsed.data.name, { manifest: parsed.data, moduleRoot })
			}
		}

		// Rebuild byName in name-sorted order so every consumer (all(),
		// the returned modules array, resolveOrder's iteration) sees a
		// deterministic, byte-identical ordering across runs.
		const sorted = Array.from(this.byName.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		this.byName.clear()
		for (const [name, value] of sorted) this.byName.set(name, value)

		if (!anyFound) {
			diagnostics.push({
				severity: "warning",
				rule: "no-modules",
				message: `no modules found in any scope (tree, project marketplace, user marketplace, or bundled)`,
			})
		}

		return { modules: this.all(), diagnostics }
	}

	/**
	 * Action ids exported by more than one discovered module, mapped to the
	 * sorted list of owning module names. An id owned by the SAME module in
	 * multiple scopes is not a collision (scope dedup has already resolved
	 * it). Used by plan-time refusal (architecture decision 12): a plan
	 * referencing a colliding id would be ambiguous about which module's
	 * action to run.
	 */
	actionIdCollisions(): Map<string, string[]> {
		const owners = new Map<string, Set<string>>()
		for (const { manifest } of this.byName.values()) {
			for (const action of manifest.actions) {
				const set = owners.get(action.id) ?? new Set<string>()
				set.add(manifest.name)
				owners.set(action.id, set)
			}
		}
		const collisions = new Map<string, string[]>()
		for (const [actionId, modules] of owners) {
			if (modules.size > 1) {
				collisions.set(
					actionId,
					Array.from(modules).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
				)
			}
		}
		return collisions
	}

	findByName(name: string): ModuleManifest | undefined {
		return this.byName.get(name)?.manifest
	}

	moduleRootFor(name: string): string | undefined {
		return this.byName.get(name)?.moduleRoot
	}

	all(): ModuleManifest[] {
		return Array.from(this.byName.values()).map((entry) => entry.manifest)
	}

	/**
	 * Topological sort of modules by their `dependencies` field. Returns the
	 * install order. Throws if a cycle is detected or a dependency is missing.
	 */
	resolveOrder(): ModuleManifest[] {
		const visited = new Set<string>()
		const visiting = new Set<string>()
		const result: ModuleManifest[] = []
		const visit = (m: ModuleManifest) => {
			if (visited.has(m.name)) return
			if (visiting.has(m.name)) throw new Error(`dependency cycle detected at ${m.name}`)
			visiting.add(m.name)
			for (const dep of m.dependencies) {
				const found = this.byName.get(dep)?.manifest
				if (!found) throw new Error(`module ${m.name} depends on ${dep}, which is not installed`)
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
	 * Run all module-level validators and return a ValidationResult.
	 * Layout errors are folded in as well.
	 */
	validate(): ValidationResult {
		const diagnostics: ValidationDiagnostic[] = []
		for (const entry of this.byName.values()) {
			const m = entry.manifest
			const moduleRoot = entry.moduleRoot
			for (const ruleId of m.moduleValidators) {
				const rulePath = join(moduleRoot, "_shared", "validators", `${validatorFilename(ruleId)}.ts`)
				if (!existsSync(rulePath)) {
					diagnostics.push({
						severity: "error",
						rule: ruleId,
						message: `${m.name}: validator ${ruleId} not found at ${rulePath}`,
					})
				}
			}
			// Action-level validator existence check (the runner that actually
			// executes them is `runValidators` in ./validator.ts; this method
			// only does structural checks).
			for (const action of m.actions) {
				for (const ruleId of action.validators ?? []) {
					const rulePath = join(moduleRoot, action.id, "validators", `${validatorFilename(ruleId)}.ts`)
					if (!existsSync(rulePath)) {
						diagnostics.push({
							severity: "error",
							rule: `${m.name}:${action.id}:${ruleId}`,
							message: `${m.name}: action "${action.id}" declares validator "${ruleId}" but ${action.id}/validators/${validatorFilename(ruleId)}.ts does not exist`,
						})
					}
				}
			}
		}
		return { kind: diagnostics.some((d) => d.severity === "error") ? "fail" : "pass", diagnostics }
	}
}
