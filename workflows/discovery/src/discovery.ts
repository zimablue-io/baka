import fs from "node:fs"
import path from "node:path"
import type { ModuleManifest } from "@repo/protocol"
import { ModuleManifestSchema } from "@repo/protocol"
import { createJiti } from "jiti"

const jiti = createJiti(process.cwd())

/**
 * Discovers modules at runtime by scanning the modules/ directory.
 * Loads and validates manifests using JITI to support TS files.
 */
export function discoverModules(rootDir: string): ModuleManifest[] {
	const modulesDir = path.join(rootDir, "modules")
	if (!fs.existsSync(modulesDir)) {
		return []
	}

	const modules = fs.readdirSync(modulesDir)
	const discoveredManifests: ModuleManifest[] = []

	for (const moduleName of modules) {
		const manifestPath = path.join(modulesDir, moduleName, "manifest.ts")

		if (fs.existsSync(manifestPath)) {
			try {
				// Dynamically load the manifest using jiti
				const module = jiti(manifestPath)
				if (module.Manifest) {
					// Validate manifest against schema
					const parsed = ModuleManifestSchema.safeParse(module.Manifest)
					if (parsed.success) {
						discoveredManifests.push(parsed.data)
					} else {
						console.error(`Invalid manifest for module ${moduleName}:`, parsed.error)
					}
				}
			} catch (e) {
				console.error(`Failed to load manifest for module ${moduleName}:`, e)
			}
		}
	}

	return discoveredManifests
}
