import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	BAKA_PROJECT_PATHS,
	BAKA_USER_DIR,
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
		const modules: ModuleManifest[] = []

		// Walk both the in-tree modules dir and the user/project marketplace
		// install dirs. Project marketplace wins on dedup; user marketplace
		// is a fallback. The bundled scope (the baka repo's in-tree modules)
		// is added when the baka repo is reachable AND the cwd looks like
		// a real project (has a package.json). The package.json gate keeps
		// the bundled scope silent in truly empty directories; without it,
		// `baka list-modules` from `/tmp` would silently return the bundled
		// modules, breaking the cwd-scoped discovery invariant.
		const searchDirs: Array<{ dir: string; scope: "tree" | "project" | "user" | "bundled"; jitiRoot: string }> = [
			{ dir: join(this.root, "modules"), scope: "tree", jitiRoot: this.root },
			{ dir: join(this.root, BAKA_PROJECT_PATHS.ROOT, "modules"), scope: "project", jitiRoot: this.root },
			{ dir: join(homedir(), ".local", "share", BAKA_USER_DIR, "modules"), scope: "user", jitiRoot: this.root },
		]
		const bundledDir = ModuleRegistry.findBundledModulesDir()
		if (bundledDir && existsSync(join(this.root, "package.json"))) {
			// jiti needs to resolve `baka-sdk` from the bundled module's
			// own `node_modules/` symlink; the baka repo root is the
			// natural lookup root for that.
			searchDirs.push({ dir: bundledDir, scope: "bundled", jitiRoot: dirname(bundledDir) })
		}

		let anyFound = false
		for (const { dir, scope, jitiRoot } of searchDirs) {
			if (!existsSync(dir)) continue
			anyFound = true
			const entries = readdirSync(dir, { withFileTypes: true })
			for (const entry of entries) {
				// Accept real directories and symlinks (so marketplace installs
				// can symlink to a local module on disk).
				if (!(entry.isDirectory() || entry.isSymbolicLink())) continue
				// Project marketplace wins on dedup.
				if (scope !== "project" && this.byName.has(entry.name)) continue
				if (scope === "project" && this.byName.has(entry.name)) {
					// Overwrite with the project version.
					this.byName.delete(entry.name)
				}
				const moduleRoot = join(dir, entry.name)
				const manifestPath = join(moduleRoot, "manifest.ts")
				if (!existsSync(manifestPath)) {
					diagnostics.push({
						severity: "warning",
						rule: "manifest-missing",
						message: `${entry.name} has no manifest.ts; skipping`,
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
						message: `${entry.name}: failed to load manifest.ts: ${err instanceof Error ? err.message : String(err)}`,
					})
					if (strict) throw err
					continue
				}

				if (!rawManifest) {
					diagnostics.push({
						severity: "error",
						rule: "manifest-export",
						message: `${entry.name}: manifest.ts did not export \`Manifest\``,
					})
					if (strict) throw new Error(diagnostics[diagnostics.length - 1].message)
					continue
				}

				const parsed = ModuleManifestSchema.safeParse(rawManifest)
				if (!parsed.success) {
					diagnostics.push({
						severity: "error",
						rule: "manifest-shape",
						message: `${entry.name}: manifest does not match schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
					})
					if (strict) throw new Error(parsed.error.message)
					continue
				}

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
				modules.push(parsed.data)
			}
		}

		if (!anyFound) {
			diagnostics.push({
				severity: "warning",
				rule: "no-modules",
				message: `no modules found in any scope (tree, project marketplace, or user marketplace)`,
			})
		}

		return { modules, diagnostics }
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
