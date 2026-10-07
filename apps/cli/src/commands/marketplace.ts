import { existsSync } from "node:fs"
import {
	listInstalledPackages,
	projectModulesDir,
	projectSettingsPath,
	removeSource,
	userModulesDir,
	userSettingsPath,
} from "@repo/ast-tooling"
import { BAKA_EXIT_CODE } from "@repo/protocol"

/**
 * `baka install <source>` and `baka remove <source>` commands
 * (architecture §5.1, milestone 5).
 *
 * Registry resolution lives at `<cwd>/.baka/settings.json`
 * `registries` — a list the user edits directly. The cli surfaces
 * that need an aggregated catalog use `baka search`, which queries
 * every registry in that list with per-source attribution (see
 * `commands/search.ts`). The bare-name install path below queries
 * the same registries in precedence order, first-found-wins
 * (decision 4).
 *
 * Removal flow: `baka remove <source>` strips the project or user
 * scope entry plus its materialized module dir.
 */

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

/**
 * `baka remove <source>` — strips the project or user scope entry
 * plus its materialized module dir.
 */
export function runRemoveCommand(source: string, opts: { cwd: string; scope: "project" | "user" }): void {
	if (!source) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka remove <source>")
	const settingsPath = opts.scope === "project" ? projectSettingsPath(opts.cwd) : userSettingsPath()
	const modulesDir = opts.scope === "project" ? projectModulesDir(opts.cwd) : userModulesDir()
	const result = removeSource(source, { settingsPath, modulesDir })
	if (!result.removed) {
		die(BAKA_EXIT_CODE.USER_ERROR, `source not in ${opts.scope} settings: ${source}`)
	}
	console.log(`removed ${source} from ${opts.scope} settings`)
}

/**
 * `baka list-packages` — project + user scope, project-wins on dedup.
 */
export function runListPackagesCommand(cwd: string): void {
	const pkgs = listInstalledPackages(cwd)
	if (pkgs.length === 0) {
		console.log("no installed packages; use `baka install <source>`")
		return
	}
	console.log(`\n${pkgs.length} package(s):\n`)
	for (const p of pkgs) {
		const exists = existsSync(p.modulePath)
		console.log(`  [${p.scope}] ${p.moduleName}`)
		console.log(`    source: ${p.source}`)
		console.log(`    path:   ${p.modulePath}${exists ? "" : " (not materialized)"}`)
	}
	console.log("")
}
