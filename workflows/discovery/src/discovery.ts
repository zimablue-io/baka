import fs from "node:fs"
import { homedir } from "node:os"
import path, { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ModuleManifest } from "@repo/protocol"
import { BAKA_USER_DIR, ModuleManifestSchema } from "@repo/protocol"
import { createJiti } from "jiti"

/**
 * Resolve the bundled-modules directory by walking up from this
 * module's source location looking for the baka repo's `modules/`
 * marker (`<repo>/modules/baka-base/manifest.ts`). Returns the
 * absolute path to `<repo>/modules/` or `null` if the baka repo is
 * not reachable. Cached on first call.
 */
let bundledModulesDirCache: string | null | undefined
function bundledModulesDir(): string | null {
	if (bundledModulesDirCache !== undefined) return bundledModulesDirCache
	const start = dirname(fileURLToPath(import.meta.url))
	let cur = start
	for (let i = 0; i < 8; i++) {
		const marker = join(cur, "modules", "baka-base", "manifest.ts")
		if (fs.existsSync(marker)) {
			bundledModulesDirCache = join(cur, "modules")
			return bundledModulesDirCache
		}
		const parent = dirname(cur)
		if (parent === cur) break
		cur = parent
	}
	bundledModulesDirCache = null
	return null
}

/**
 * Loads and validates a single module manifest from `manifestPath` via
 * jiti. Returns the parsed manifest on success or `null` on any failure
 * (the caller logs the failure). The `jitiRoot` is the directory jiti
 * uses to resolve bare imports like `baka-sdk`; for project-scoped
 * modules that's the cwd, for bundled modules it's the baka repo root.
 */
function loadManifest(manifestPath: string, jitiRoot: string): ModuleManifest | null {
	try {
		const j = createJiti(jitiRoot, { interopDefault: true })
		const mod = j(manifestPath) as { Manifest?: unknown }
		if (!mod.Manifest) return null
		const parsed = ModuleManifestSchema.safeParse(mod.Manifest)
		if (!parsed.success) {
			console.error(`Invalid manifest at ${manifestPath}:`, parsed.error)
			return null
		}
		return parsed.data
	} catch (e) {
		console.error(`Failed to load manifest at ${manifestPath}:`, e)
		return null
	}
}

/**
 * Discovers modules at runtime by scanning:
 *   1. `<rootDir>/modules/` — the project tree (cwd-scoped; this is the
 *      authoritative scope and is what the validation contract calls
 *      "cwd-scoped discovery").
 *   2. The baka repo's bundled `modules/` — when the repo is reachable
 *      AND the cwd looks like a real project (has a package.json). The
 *      package.json gate keeps this silent in truly empty directories.
 *   3. The user marketplace (`~/.baka/modules/`) — the
 *      marketplace install scope.
 *
 * Bundled modules are deduped by name against the tree scope (tree wins
 * on conflict). User-scope modules fill in any remaining gaps.
 */
export function discoverModules(rootDir: string): ModuleManifest[] {
	const discovered = new Map<string, ModuleManifest>()

	// 1. Tree scope: <rootDir>/modules/*.
	const treeDir = path.join(rootDir, "modules")
	if (fs.existsSync(treeDir)) {
		for (const moduleName of fs.readdirSync(treeDir)) {
			const manifestPath = path.join(treeDir, moduleName, "manifest.ts")
			if (!fs.existsSync(manifestPath)) continue
			const m = loadManifest(manifestPath, rootDir)
			if (m) discovered.set(m.name, m)
		}
	}

	// 2. Bundled scope: the baka repo's modules/ when reachable.
	const bundled = bundledModulesDir()
	if (bundled && fs.existsSync(path.join(rootDir, "package.json"))) {
		const jitiRoot = dirname(bundled)
		for (const moduleName of fs.readdirSync(bundled)) {
			if (discovered.has(moduleName)) continue // tree wins on dedup
			const manifestPath = path.join(bundled, moduleName, "manifest.ts")
			if (!fs.existsSync(manifestPath)) continue
			const m = loadManifest(manifestPath, jitiRoot)
			if (m) discovered.set(m.name, m)
		}
	}

	// 3. User scope: ~/.baka/modules/*.
	const userDir = path.join(homedir(), `.${BAKA_USER_DIR}`, "modules")
	if (fs.existsSync(userDir)) {
		for (const moduleName of fs.readdirSync(userDir)) {
			if (discovered.has(moduleName)) continue
			const manifestPath = path.join(userDir, moduleName, "manifest.ts")
			if (!fs.existsSync(manifestPath)) continue
			const m = loadManifest(manifestPath, rootDir)
			if (m) discovered.set(m.name, m)
		}
	}

	return Array.from(discovered.values())
}
