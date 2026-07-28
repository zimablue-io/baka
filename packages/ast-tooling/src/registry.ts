import { type Dirent, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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

export class ModuleRegistry {
	private readonly byName = new Map<string, { manifest: ModuleManifest; moduleRoot: string }>()
	private readonly root: string

	constructor(root: string) {
		this.root = resolve(root)
	}

	/**
	 * Resolve the bundled-modules directory by walking up from this
	 * module's source location looking for the baka repo's `modules/`
	 * marker (`<repo>/modules/baka-base/manifest.ts`). Returns the
	 * absolute path to `<repo>/modules/` or `null` if the baka repo is
	 * not reachable (e.g. when the dist is globally linked and the
	 * bundled modules are not shipped in the tarball).
	 *
	 * The walk-up is anchored on `import.meta.url` rather than `cwd`
	 * so the result is correct regardless of which directory the user
	 * runs `baka` from. The function is computed once at module load
	 * and memoized.
	 */
	private static readonly bundledModulesDirCache: { value: string | null | undefined } = { value: undefined }
	private static findBundledModulesDir(): string | null {
		if (ModuleRegistry.bundledModulesDirCache.value !== undefined) {
			return ModuleRegistry.bundledModulesDirCache.value
		}
		// Walk up at most 8 levels. In the baka repo, the registry is at
		// `packages/ast-tooling/src/registry.ts` (4 levels up = baka/).
		// In the dist, it's inlined at `apps/cli/dist/index.js` (4 levels
		// up = baka/). Globally linked installs won't find the marker.
		const start = dirname(fileURLToPath(import.meta.url))
		let cur = start
		for (let i = 0; i < 8; i++) {
			const marker = join(cur, "modules", "baka-base", "manifest.ts")
			if (existsSync(marker)) {
				ModuleRegistry.bundledModulesDirCache.value = join(cur, "modules")
				return ModuleRegistry.bundledModulesDirCache.value
			}
			const parent = dirname(cur)
			if (parent === cur) break
			cur = parent
		}
		ModuleRegistry.bundledModulesDirCache.value = null
		return null
	}

	/**
	 * The module search scopes, in discovery iteration order: in-tree
	 * modules, the project marketplace, the user marketplace, and the
	 * bundled scope (the baka repo's own modules/, when reachable).
	 */
	private searchScopes(): Array<{ dir: string; scope: "tree" | "project" | "user" | "bundled"; jitiRoot: string }> {
		const scopes: Array<{ dir: string; scope: "tree" | "project" | "user" | "bundled"; jitiRoot: string }> = [
			{ dir: join(this.root, "modules"), scope: "tree", jitiRoot: this.root },
			{ dir: join(this.root, BAKA_PROJECT_PATHS.ROOT, "modules"), scope: "project", jitiRoot: this.root },
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
	 * Scope precedence for discovery dedup and single-module resolution:
	 * project marketplace wins, then tree, then user marketplace, then
	 * bundled. The first scope (in this order) that provides a module name
	 * owns it; lower-precedence copies are skipped.
	 */
	private static readonly SCOPE_PRECEDENCE = ["project", "tree", "user", "bundled"] as const

	/**
	 * Resolve the on-disk root of a single named module across every scope,
	 * without parsing its manifest. Precedence mirrors discover()'s dedup
	 * rules: project marketplace wins, then tree, then user marketplace,
	 * then bundled. Unlike discover(), the bundled scope is always probed:
	 * resolving an explicitly-named module (e.g. a plan step's target) is
	 * not gated on the cwd looking like a project.
	 */
	resolveModuleRoot(name: string): string | undefined {
		const scopes = this.searchScopes()
		for (const scopeName of ModuleRegistry.SCOPE_PRECEDENCE) {
			const scope = scopes.find((s) => s.scope === scopeName)
			if (!scope) continue
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
	 *   - one folder per declared action, containing action.ts
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
		const scopes = this.searchScopes()
		const bundledEnabled = existsSync(join(this.root, "package.json"))

		let anyFound = false
		for (const scopeName of ModuleRegistry.SCOPE_PRECEDENCE) {
			const scope = scopes.find((s) => s.scope === scopeName)
			if (!scope) continue
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
						message: `${entry.name} (${manifestPath}): failed to load manifest.ts: ${err instanceof Error ? err.message : String(err)}`,
					})
					if (strict) throw err
					continue
				}

				if (!rawManifest) {
					diagnostics.push({
						severity: "error",
						rule: "manifest-export",
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
					if (!existsSync(actionTs)) {
						diagnostics.push({
							severity: "error",
							rule: "action-missing",
							message: `${entry.name}: action "${action.id}" is missing ${action.id}/action.ts`,
						})
					}
					if (action.requiresReasoning) {
						const tpl = join(moduleRoot, action.id, "templates")
						if (!existsSync(tpl)) {
							diagnostics.push({
								severity: "error",
								rule: "templates-missing",
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
		if (diagnostics.some((d) => d.severity === "error")) return { kind: "fail", diagnostics }
		return { kind: "pass" }
	}
}
