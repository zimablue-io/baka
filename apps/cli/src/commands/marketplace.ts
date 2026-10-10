import { existsSync } from "node:fs"
import {
	listInstalledPackages,
	projectPacksDir,
	projectSettingsPath,
	removeSource,
	userPacksDir,
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
 * scope entry plus its materialized pack dir.
 */

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

/**
 * `baka remove <source>` — strips the project or user scope entry
 * plus its materialized pack dir.
 */
export function runRemoveCommand(source: string, opts: { cwd: string; scope: "project" | "user" }): void {
	if (!source) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka remove <source>")
	const settingsPath = opts.scope === "project" ? projectSettingsPath(opts.cwd) : userSettingsPath()
	const packsDir = opts.scope === "project" ? projectPacksDir(opts.cwd) : userPacksDir()
	const result = removeSource(source, { settingsPath, packsDir })
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
		const exists = existsSync(p.packPath)
		console.log(`  [${p.scope}] ${p.packName}`)
		console.log(`    source: ${p.source}`)
		console.log(`    path:   ${p.packPath}${exists ? "" : " (not materialized)"}`)
	}
	console.log("")
}
