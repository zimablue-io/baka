import { existsSync } from "node:fs"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import {
	installSource,
	listInstalledPackages,
	parseSource,
	projectModulesDir,
	projectSettingsPath,
	readProjectSettings,
	readUserSettings,
	removeSource,
	updateAll,
	userModulesDir,
	userSettingsPath,
} from "@repo/ast-tooling"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

export async function runInstallCommand(source: string, opts: { cwd: string; scope: "project" | "user" }): Promise<void> {
	if (!source) die(BAKA_EXIT_CODE.USER_ERROR, "usage: baka install <source>")
	const parsed = parseSource(source)
	const settingsPath = opts.scope === "project" ? projectSettingsPath(opts.cwd) : userSettingsPath()
	const modulesDir = opts.scope === "project" ? projectModulesDir(opts.cwd) : userModulesDir()

	console.log(`installing ${parsed.type}: ${parsed.raw} -> ${modulesDir}/${parsed.moduleName} (${opts.scope} scope)`)
	try {
		const result = await installSource(source, {
			scope: opts.scope,
			cwd: opts.cwd,
			settingsPath,
			modulesDir,
		})
		console.log(`  installed: ${result.modulePath}`)
		console.log(`  registered in: ${settingsPath}`)
	} catch (err) {
		die(BAKA_EXIT_CODE.ENGINE_ERROR, `install failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

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

export async function runUpdateCommand(cwd: string): Promise<void> {
	const results = await updateAll(cwd)
	if (results.length === 0) {
		console.log("no packages to update")
		return
	}
	for (const r of results) {
		if (r.updated) {
			console.log(`  updated: ${r.source}`)
		} else if (r.reason === "pinned") {
			console.log(`  skipped (pinned): ${r.source}`)
		} else {
			console.log(`  skipped: ${r.source}${r.reason ? ` (${r.reason})` : ""}`)
		}
	}
}
