import * as fs from "node:fs"
import path from "node:path"
import type { ModuleManifest } from "@repo/protocol"

/**
 * Discovers modules at runtime by scanning the modules/ directory.
 * This is a utility function used by workflows, not a package.
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
			// NOTE: In a real environment, we'd need to handle ESM imports of these TS files.
			// For now, we assume a structured scan or pre-compiled manifest JSON.
			// As a first step, we simply detect the presence.
			discoveredManifests.push({
				name: moduleName,
				version: "1.0.0",
				dependencies: [],
				actions: [], // Action details would be populated by reading/parsing the manifest.ts
			})
		}
	}

	return discoveredManifests
}
