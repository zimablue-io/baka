#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ModuleRegistry } from "@repo/ast-tooling"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { Command } from "commander"
import { runConfigGet, runConfigList, runConfigPath, runConfigSet, runConfigUnset } from "./commands/config"
import { runInit } from "./commands/init"
import {
	runInstallCommand,
	runListPackagesCommand,
	runMarketplaceAdd,
	runMarketplaceList,
	runMarketplaceRemove,
	runMarketplaceUpdate,
	runRemoveCommand,
	runUpdateCommand,
} from "./commands/marketplace"
import { runModuleEdit, runModuleListActions, runModuleTest, runModuleValidate } from "./commands/module"
import { runApplyCommand, runListPlans, runPlanCommand, runValidateCommand } from "./commands/plan"
import { runProvidersAdd, runProvidersList, runProvidersRemove, runProvidersUse } from "./commands/providers"
import { runSearchCommand } from "./commands/search"

function die(code: number, msg: string): never {
	process.stderr.write(`baka: ${msg}\n`)
	process.exit(code)
}

// Read the CLI's version from its own package.json. Per architecture
// invariant 7, the root package.json is the version of record and
// apps/cli/package.json MUST match it. Reading at runtime keeps the dist in
// sync with whatever version is checked into apps/cli/package.json — no
// build-time rewrite or hardcoded string to drift from the source.
const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string }

const program = new Command()

program
	.name("baka")
	.description("Baka CLI: enforce your patterns by routing LLM intent through declared module actions")
	.version(cliPkg.version)

program
	.option("-p, --provider <name>", "use the named provider (overrides active)")
	.option("--cwd <path>", "use the given directory as the project root", process.cwd())

// Validate --cwd up front: a non-existent path is a USER_ERROR (the user
// gave us a bad path), not a silent no-op that returns zero results.
// `preAction` fires before every subcommand action handler; --help /
// --version don't fire actions so they remain unaffected.
program.hook("preAction", () => {
	const opts = program.opts<{ cwd?: string }>()
	const cwd = opts.cwd ?? process.cwd()
	if (!existsSync(cwd)) {
		die(BAKA_EXIT_CODE.USER_ERROR, `cwd does not exist: ${cwd}`)
	}
})

// `baka init` -----------------------------------------------------------------

program
	.command("init")
	.description("Interactive first-time setup: provider, model, API key")
	.action(async () => {
		try {
			await runInit()
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.USER_ERROR, message)
		}
	})

// `baka config *` -------------------------------------------------------------

const configCmd = program.command("config").description("View and edit the baka user config (non-secret values)")

configCmd.command("list").description("List all config keys (sensitive values redacted)").action(runConfigList)
configCmd.command("get <key>").description("Get a config value (refuses sensitive keys)").action(runConfigGet)
configCmd.command("set <key> <value>").description("Set a config value (refuses sensitive keys)").action(runConfigSet)
configCmd.command("unset <key>").description("Remove a config key").action(runConfigUnset)
configCmd.command("path").description("Show the user config and credentials file paths").action(runConfigPath)

// `baka providers *` ----------------------------------------------------------

const providersCmd = program.command("providers").description("Manage LLM providers (user-configured)")

providersCmd
	.command("add [name]")
	.description("Add a new provider (interactive)")
	.action(async (_name) => {
		try {
			await runProvidersAdd()
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.USER_ERROR, message)
		}
	})

providersCmd.command("list").description("List configured providers").action(runProvidersList)

providersCmd
	.command("use [name]")
	.description("Switch the active provider")
	.action(async (name) => {
		try {
			await runProvidersUse(name)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.USER_ERROR, message)
		}
	})

providersCmd
	.command("remove [name]")
	.description("Remove a provider")
	.action(async (name) => {
		try {
			await runProvidersRemove(name)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.USER_ERROR, message)
		}
	})

// `baka module *` -------------------------------------------------------------

const moduleCmd = program.command("module").description("Author, validate, and test modules")

moduleCmd
	.command("create <name>")
	.description(
		"Design a new module through a chat-driven double-diamond flow (Discover -> Define -> Develop -> Deliver). Re-run to resume.",
	)
	.action(async (name) => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		// Lazy-load: a broken module-design barrel must not kill sibling subcommands.
		const { runModuleDesign } = await import("./commands/module-design/index.js")
		try {
			await runModuleDesign(name, { cwd })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.ENGINE_ERROR, message)
		}
	})

moduleCmd
	.command("consistency <name>")
	.description("Run the 5x consistency test on a designed module")
	.option("-a, --action <id>", "the action id to test (default: first action)")
	.option("-i, --intent <text>", "the user intent to plan against (default: action's testIntent)")
	.option("-n, --n <count>", "number of runs (default: 5)", "5")
	.action(async (name, opts) => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		// Lazy-load: a broken module-design barrel must not kill sibling subcommands.
		const { runModuleConsistency } = await import("./commands/module-design/index.js")
		try {
			await runModuleConsistency(name, {
				cwd,
				actionId: opts.action,
				intent: opts.intent,
				n: Number(opts.n ?? 5),
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			die(BAKA_EXIT_CODE.ENGINE_ERROR, message)
		}
	})

moduleCmd
	.command("validate <name>")
	.description("Check a module's manifest and layout")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp manifest resource)")
	.action((name, opts) => runModuleValidate(name, { json: opts.json }))
moduleCmd.command("list-actions <name>").description("Show a module's actions").action(runModuleListActions)

moduleCmd
	.command("test <name>")
	.description("Run a single action in an isolated temp dir")
	.option("-a, --action <id>", "the action id to run (required)")
	.option("-i, --input <json>", "JSON input for the action", "{}")
	.action(async (name, opts) => {
		if (!opts.action) die(BAKA_EXIT_CODE.USER_ERROR, "--action <id> is required")
		await runModuleTest(name, opts.action, opts.input ?? "{}")
	})

moduleCmd
	.command("edit <name>")
	.description("Open the module's manifest in $EDITOR, then re-validate")
	.action(async (name) => {
		try {
			await runModuleEdit(name)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.USER_ERROR, message)
		}
	})

// `baka list-modules` ---------------------------------------------------------

program
	.command("list-modules")
	.description("List all discoverable modules (in-tree + project + user marketplace scopes)")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka://modules` resource)")
	.action((opts) => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		const registry = new ModuleRegistry(cwd)
		const { modules, diagnostics } = registry.discover(false)
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						modules: modules.map((m) => ({
							name: m.name,
							version: m.version,
							description: m.description,
							actions: m.actions.length,
							uri: `baka://module/${m.name}/manifest`,
						})),
						diagnostics,
					},
					null,
					2,
				),
			)
			return
		}
		console.log(`\nFound ${modules.length} module(s):\n`)
		if (modules.length === 0) {
			for (const d of diagnostics) console.log(`  (${d.severity}) ${d.message}`)
		} else {
			modules.forEach((m) => {
				console.log(`  - ${m.name.padEnd(20)} v${m.version}`)
				console.log(`    Actions: ${m.actions.length}`)
				console.log(`    Deps:    ${m.dependencies.join(", ") || "none"}`)
			})
		}
		console.log("")
	})

// `baka plan` -----------------------------------------------------------------

program
	.command("plan")
	.description("Plan a new feature intent")
	.argument("[intent]", "The feature intent to plan", "Set up core typescript application with default configurations")
	.option("--dry-run", "preview the plan without executing")
	.option("--save", "persist the plan to .baka/plans/")
	.option("--execute", "execute the plan after planning (Phase 7)")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka_plan` tool)")
	.action(async (intent, opts) => {
		const globalOpts = program.opts<{ provider?: string; cwd?: string }>()
		try {
			await runPlanCommand(intent, {
				provider: globalOpts.provider ?? opts.provider,
				cwd: globalOpts.cwd,
				dryRun: opts.dryRun,
				save: opts.save,
				json: opts.json,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka list-plans` -----------------------------------------------------------

program
	.command("list-plans")
	.description("List saved plan files")
	.action(() => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		runListPlans(cwd)
	})

// `baka apply <plan-file>` ---------------------------------------------------

program
	.command("apply <plan-file>")
	.description("Apply a saved plan (executes the steps with SAGA compensation)")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka_apply` tool)")
	.action(async (planFile, opts) => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		try {
			await runApplyCommand(planFile, cwd, { json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka validate` ------------------------------------------------------------

program
	.command("validate")
	.description("Run all module validators against the current project")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka_validate` tool)")
	.option(
		"-m, --module <name>",
		"run validators for a single module only; exits BAKA_EXIT_CODE.USER_ERROR (1) if the module is not found",
	)
	.action(async (opts) => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		try {
			await runValidateCommand(cwd, { json: opts.json, module: opts.module })
		} catch (err) {
			die(BAKA_EXIT_CODE.VALIDATION_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka install <source>` ----------------------------------------------------

program
	.command("install <source>")
	.description(
		"Install a module package. Accepts npm:..., git:..., local paths, or a bare module name (resolved via the marketplace API).",
	)
	.option("-l, --local", "install to the project scope (default) vs. user scope")
	.option("-u, --user", "install to the user scope (~/.baka/modules/)")
	.action(async (source, opts) => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		const scope = opts.user ? "user" : "project"
		try {
			await runInstallCommand(source, { cwd, scope })
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka remove <source>` -----------------------------------------------------

program
	.command("remove <source>")
	.description("Remove a module package from settings (and from disk if materialized)")
	.option("-u, --user", "remove from the user scope")
	.action((source, opts) => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		const scope = opts.user ? "user" : "project"
		try {
			runRemoveCommand(source, { cwd, scope })
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka list-packages` -------------------------------------------------------

program
	.command("list-packages")
	.description("List installed module packages (project + user scopes; project wins on dedup)")
	.action(() => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		runListPackagesCommand(cwd)
	})

// `baka update` --------------------------------------------------------------

program
	.command("update")
	.description("Update all unpinned packages; pinned ones are reconciled but not moved")
	.action(async () => {
		const cwd = program.opts<{ cwd?: string }>().cwd ?? process.cwd()
		try {
			await runUpdateCommand(cwd)
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka marketplace add | list | remove | update` ---------------------------

const marketplaceCatalogCmd = program
	.command("marketplace")
	.description("Manage your subscribed community marketplace catalogs")

marketplaceCatalogCmd
	.command("add <url>")
	.description("Subscribe to a community catalog URL")
	.action((url) => runMarketplaceAdd(url))

marketplaceCatalogCmd
	.command("list")
	.description("List your subscribed community catalogs")
	.action(() => runMarketplaceList())

marketplaceCatalogCmd
	.command("remove <url>")
	.description("Unsubscribe from a community catalog URL")
	.action((url) => runMarketplaceRemove(url))

marketplaceCatalogCmd
	.command("update")
	.description("Re-fetch subscribed catalogs (no-op in v1; catalogs are fetched on demand)")
	.action(() => runMarketplaceUpdate())

// `baka search <query>` -----------------------------------------------------

program
	.command("search <query>")
	.description("Search modules across the built-in catalog + your subscribed community catalogs")
	.action(async (query) => {
		try {
			await runSearchCommand(query)
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

program.parse(process.argv)
