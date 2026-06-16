import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
	BAKA_PROJECT_PATHS,
	BAKA_USER_DIR,
	type ModuleManifest,
	ModuleManifestSchema,
	type ValidationDiagnostic,
	type ValidationResult,
} from "@repo/protocol"
import { createJiti } from "jiti"

export class ModuleRegistry {
	private readonly byName = new Map<string, ModuleManifest>()
	private readonly root: string

	constructor(root: string) {
		this.root = resolve(root)
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
		// is a fallback.
		const searchDirs: Array<{ dir: string; scope: "tree" | "project" | "user" }> = [
			{ dir: join(this.root, "modules"), scope: "tree" },
			{ dir: join(this.root, BAKA_PROJECT_PATHS.ROOT, "modules"), scope: "project" },
			{ dir: join(homedir(), ".local", "share", BAKA_USER_DIR, "modules"), scope: "user" },
		]

		let anyFound = false
		for (const { dir, scope } of searchDirs) {
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
					const jiti = createJiti(this.root, { interopDefault: true })
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
						const rulePath = join(moduleRoot, action.id, "validators", `${ruleId}.ts`)
						if (!existsSync(rulePath)) {
							diagnostics.push({
								severity: "error",
								rule: "action-validator-missing",
								message: `${entry.name}: action "${action.id}" declares validator "${ruleId}" but ${action.id}/validators/${ruleId}.ts does not exist`,
							})
						}
					}
				}

				this.byName.set(parsed.data.name, parsed.data)
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
		return this.byName.get(name)
	}

	all(): ModuleManifest[] {
		return Array.from(this.byName.values())
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
				const found = this.byName.get(dep)
				if (!found) throw new Error(`module ${m.name} depends on ${dep}, which is not installed`)
				visit(found)
			}
			visiting.delete(m.name)
			visited.add(m.name)
			result.push(m)
		}
		for (const m of this.byName.values()) visit(m)
		return result
	}

	/**
	 * Run all module-level validators and return a ValidationResult.
	 * Layout errors are folded in as well.
	 */
	validate(): ValidationResult {
		const diagnostics: ValidationDiagnostic[] = []
		for (const m of this.all()) {
			for (const ruleId of m.moduleValidators) {
				const rulePath = join(this.root, "modules", m.name, "_shared", "validators", `${ruleId}.ts`)
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
					const rulePath = join(this.root, "modules", m.name, action.id, "validators", `${ruleId}.ts`)
					if (!existsSync(rulePath)) {
						diagnostics.push({
							severity: "error",
							rule: `${m.name}:${action.id}:${ruleId}`,
							message: `${m.name}: action "${action.id}" declares validator "${ruleId}" but ${action.id}/validators/${ruleId}.ts does not exist`,
						})
					}
				}
			}
		}
		if (diagnostics.some((d) => d.severity === "error")) return { kind: "fail", diagnostics }
		return { kind: "pass" }
	}
}
