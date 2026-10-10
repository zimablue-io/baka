#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findBundledPacks } from "@baka/engine"
import { isolatedFromEnv, llmCallFromEnv } from "@repo/agent-engine"
import {
	AddonLoadError,
	addonSpecsFromEnv,
	loadAddons,
	PackDirsError,
	packDirsFromEnv,
	resolvePackDirs,
} from "@repo/ast-tooling"
import { BAKA_EXIT_CODE, type BakaAddon, type LlmCall } from "@repo/protocol"
import { Command } from "commander"
import type { CallOptions } from "./call"
import { runHealthCommand, runSchemaCommand, runVersionCommand } from "./commands/contract"
import { runInit } from "./commands/init"
import { InstallCommandError, runInstallCommand, runUninstallCommand } from "./commands/install"
import { runListPackagesCommand, runRemoveCommand } from "./commands/marketplace"
import { runOrgCreateCommand, runOrgInviteCommand, runOrgListCommand } from "./commands/org"
import { runPackEdit, runPackListRecipes, runPackTest, runPackValidate } from "./commands/pack"
import { runPackManifest } from "./commands/pack-manifest"
import { runApplyCommand, runListPlans, runPlanCommand, runValidateCommand } from "./commands/plan"
import { runPublishCommand } from "./commands/publish"
import {
	runRegistryInfo,
	runRegistryList,
	runRegistryLogin,
	runRegistryLogout,
	runRegistryPreview,
	runRegistryWhoami,
} from "./commands/registry"
import { runRole, runRolePath, runRoleShow } from "./commands/role"
import { runRoles } from "./commands/roles"
import {
	runFillCommand,
	runInspectCommand,
	runListPacksCommand,
	runLockCommand,
	runRunCommand,
	runServeCommand,
	runSlotsCommand,
} from "./commands/run"
import { runSearchCommand } from "./commands/search"
import { die } from "./die"

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
	.description("Baka CLI: enforce your patterns by routing LLM intent through declared pack recipes")
	.version(cliPkg.version)

// A relative --cwd is resolved here, once, so every command sees an absolute project root.
program.option(
	"--cwd <path>",
	"use the given directory as the project root (relative paths resolve against the current directory)",
	(value: string) => resolve(value),
	process.cwd(),
)
// The project root and the pack scope are separate: --packs-dir (or BAKA_PACK_DIRS, or the project's
// `.baka/settings.json` `packDirs`) names the directories packs are drawn from, so a catalog elsewhere can
// serve any project without symlinks and without being written to.
program.option(
	"--packs-dir <path>",
	"directory containing <pack>/manifest.ts entries; repeatable, highest precedence first. When given (or BAKA_PACK_DIRS is set, or .baka/settings.json lists packDirs) ONLY these are searched, instead of the project's packs/, .baka/packs, and the user marketplace. Precedence: this flag, BAKA_PACK_DIRS, settings packDirs",
	(value: string, prior: string[]) => [...prior, resolve(value)],
	[] as string[],
)

// Per-call configuration: a host passes everything a call needs on the call itself, so nothing depends on
// what happens to be in the user's home directory.
program.option(
	"--isolated",
	"read nothing from the user directory (~/.baka): no user packs, no stored model, no user slot cache. The call is decided by its flags, environment and project (env: BAKA_ISOLATED=1)",
)
program.option(
	"--llm-base-url <url>",
	"OpenAI-compatible endpoint for slots the call must fill (env: BAKA_LLM_BASE_URL)",
)
program.option(
	"--addon <module>",
	"attach an add-on to this call: a module path or a package name whose default export is an add-on; repeatable (env: BAKA_ADDONS, separated like PATH)",
	(value: string, prior: string[]) => [...prior, value],
	[] as string[],
)
program.option("--llm-model <name>", "model name for the endpoint (env: BAKA_LLM_MODEL)")
program.option(
	"--llm-api-key-env <name>",
	"name of the environment variable that holds the API key; the key itself never appears in argv",
)
program.option(
	"--llm-api-key <key>",
	"the API key (env: BAKA_LLM_API_KEY; prefer --llm-api-key-env, flags show up in ps)",
)

/** The project root, for commands that never read packs (and so never fail on a pack-directory setting). */
function projectCwd(): string {
	return program.opts<{ cwd?: string }>().cwd ?? process.cwd()
}

/** `--packs-dir`, then `BAKA_PACK_DIRS`: what the caller named; the project's settings are not consulted. */
function explicitPackDirs(): string[] | undefined {
	const flag = program.opts<{ packsDir?: string[] }>().packsDir
	return flag?.length ? flag : packDirsFromEnv(process.env)
}

/** The model this call names: `BAKA_LLM_*` first, each `--llm-*` flag over it. Undefined when it names none. */
function callLlm(): LlmCall | undefined {
	const flags = program.opts<{ llmBaseUrl?: string; llmModel?: string; llmApiKey?: string; llmApiKeyEnv?: string }>()
	const call: LlmCall = {
		...llmCallFromEnv(process.env),
		...(flags.llmBaseUrl ? { baseUrl: flags.llmBaseUrl } : {}),
		...(flags.llmModel ? { model: flags.llmModel } : {}),
		...(flags.llmApiKey ? { apiKey: flags.llmApiKey } : {}),
		...(flags.llmApiKeyEnv ? { apiKeyEnv: flags.llmApiKeyEnv } : {}),
	}
	return Object.keys(call).length > 0 ? call : undefined
}

/**
 * What every pack-reading command works with: the project root, the pack directories (the flag, then
 * BAKA_PACK_DIRS, then `packDirs` of `<cwd>/.baka/settings.json`, else undefined for default
 * discovery), whether the user directory may be read, the model the call names, and the packs that
 * ship with this install. A setting that cannot be honoured ends the command as bad input naming
 * the file and the entry.
 */
function globals(): CallOptions {
	const cwd = projectCwd()
	try {
		return {
			cwd,
			packDirs: resolvePackDirs({ root: cwd, flag: program.opts<{ packsDir?: string[] }>().packsDir }),
			isolated: program.opts<{ isolated?: boolean }>().isolated === true || isolatedFromEnv(process.env),
			llm: callLlm(),
			bundledPacksDir: findBundledPacks(import.meta.url),
			addons,
		}
	} catch (err) {
		if (err instanceof PackDirsError) die(BAKA_EXIT_CODE.BAD_INPUT, err.message)
		throw err
	}
}

// Validate --cwd up front: a non-existent path is a BAD_INPUT (the user
// gave us a bad path), not a silent no-op that returns zero results.
// `preAction` fires before every subcommand recipe handler; --help /
// --version don't fire recipes so they remain unaffected.
let addons: BakaAddon[] = []
program.hook("preAction", async () => {
	const opts = program.opts<{ cwd?: string; addon?: string[] }>()
	const cwd = opts.cwd ?? process.cwd()
	if (!existsSync(cwd)) {
		die(BAKA_EXIT_CODE.BAD_INPUT, `cwd does not exist: ${cwd}`)
	}
	// Only what the caller named is loaded: the open engine never goes looking for add-ons.
	const specs = opts.addon?.length ? opts.addon : addonSpecsFromEnv(process.env)
	try {
		addons = await loadAddons(specs, cwd)
	} catch (err) {
		if (err instanceof AddonLoadError) die(BAKA_EXIT_CODE.BAD_INPUT, err.message, { code: "addon-invalid" })
		throw err
	}
})

// `baka version | health | schema` (what a host checks before it uses this install) ----

program
	.command("version")
	.description("Print the handshake: name, version, the contract it speaks and what it can do")
	.option("--json", "emit the handshake document (baka.handshake/1) to stdout")
	.option("--require-contract <major>", "exit 3 unless this install speaks that contract major")
	.option(
		"--require <capability>",
		"exit 3 unless this install has the capability (repeatable)",
		(name: string, prior: string[]) => [...prior, name],
		[] as string[],
	)
	.action((opts) => {
		runVersionCommand({
			version: cliPkg.version,
			json: opts.json,
			requireContract: opts.requireContract,
			require: opts.require,
		})
	})

program
	.command("health")
	.description("Check that this install can do its job; exit 3 when it cannot")
	.option("--json", "emit the health document (baka.health/1) to stdout")
	.action((opts) => {
		const { cwd, bundledPacksDir } = globals()
		runHealthCommand({ cwd, bundledPacksDir, json: opts.json })
	})

program
	.command("schema")
	.description("List the ids of the documents Baka publishes, or print the JSON Schema of one")
	.argument("[id]", "a document id such as baka.receipt/1")
	.option("--json", "with no id, list the ids as JSON")
	.action((id, opts) => {
		runSchemaCommand(id, { json: opts.json })
	})

// `baka init` -----------------------------------------------------------------

program
	.command("init")
	.description("Interactive first-time setup: configure both worker and validator roles")
	.action(async () => {
		try {
			await runInit()
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.BAD_INPUT, message)
		}
	})

// `baka role *` ---------------------------------------------------------------
//
// Per-role management. `baka role <worker|validator>` opens an interactive
// edit; `baka role <name> --field <name> --value <val>` mutates one field
// non-interactively; `baka role <name> show` prints the current block;
// `baka role path` prints the user config path.

const roleCmd = program.command("role").description("View or edit one role's LLM config")

roleCmd
	.command("show <name>")
	.description("Print one role's config (apiKey masked)")
	.action((name) => runRoleShow(name))

roleCmd.command("path").description("Print the user config path").action(runRolePath)

roleCmd
	.argument("<name>", "the role name (worker or validator)")
	.option("--field <name>", "the field to set (baseUrl, model, apiKey, temperature, maxTokens, timeoutMs, seed)")
	.option("--value <value>", "the new value for the field")
	.description("Edit one role's LLM config (interactive, or --field/--value)")
	.action(async (name, opts) => {
		try {
			await runRole(name, { field: opts.field, value: opts.value })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.BAD_INPUT, message)
		}
	})

// `baka roles` ----------------------------------------------------------------

program
	.command("roles")
	.description("List every configured role with its fields (apiKey masked)")
	.action(() => {
		try {
			runRoles()
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			die(BAKA_EXIT_CODE.BAD_INPUT, message)
		}
	})

// `baka pack *` -------------------------------------------------------------

const packCmd = program.command("pack").description("Author, validate, and test packs")

packCmd
	.command("create <name>")
	.description(
		"Design a new pack through a chat-driven double-diamond flow (Discover -> Define -> Develop -> Deliver). Re-run to resume.",
	)
	.action(async (name) => {
		const cwd = projectCwd()
		// Lazy-load: a broken pack-design barrel must not kill sibling subcommands.
		const { runPackDesign } = await import("./commands/pack-design/index.js")
		try {
			await runPackDesign(name, { cwd })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.FAILED, message)
		}
	})

packCmd
	.command("consistency <name>")
	.description("Run the 5x consistency test on a designed pack")
	.option("-a, --recipe <id>", "the recipe id to test (default: first recipe)")
	.option("-i, --intent <text>", "the user intent to plan against (default: recipe's testIntent)")
	.option("-n, --n <count>", "number of runs (default: 5)", "5")
	.action(async (name, opts) => {
		const cwd = projectCwd()
		// Lazy-load: a broken pack-design barrel must not kill sibling subcommands.
		const { runPackConsistency } = await import("./commands/pack-design/index.js")
		try {
			await runPackConsistency(name, {
				cwd,
				recipeId: opts.recipe,
				intent: opts.intent,
				n: Number(opts.n ?? 5),
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			die(BAKA_EXIT_CODE.FAILED, message)
		}
	})

packCmd
	.command("manifest")
	.description("Print, write or check the moralo.module.json of a repository of packs, so it can be shared")
	.argument("[dir]", "the pack, or the repository whose subdirectories are packs (default: the current directory)")
	.option("--id <owner/name>", "the module id; by default package.json or the git remote says")
	.option("--write", "write moralo.module.json next to the packs")
	.option("--check", "exit 1 unless the file on disk matches the packs (for CI)")
	.option("--json", "emit the result as JSON")
	.action((dir, opts) => {
		runPackManifest(dir, { cwd: projectCwd(), id: opts.id, write: opts.write, check: opts.check, json: opts.json })
	})

packCmd
	.command("validate <name>")
	.description("Check a pack's manifest and layout")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp manifest resource)")
	.action((name, opts) => {
		runPackValidate(name, { ...globals(), json: opts.json })
	})
packCmd
	.command("list-recipes <name>")
	.description("Show a pack's recipes")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka_list_recipes` tool)")
	.action((name, opts) => {
		runPackListRecipes(name, { ...globals(), json: opts.json })
	})

packCmd
	.command("test <name>")
	.description("Run a single recipe in an isolated temp dir")
	.option("-a, --recipe <id>", "the recipe id to run (required)")
	.option("-i, --input <json>", "JSON input for the recipe", "{}")
	.action(async (name, opts) => {
		if (!opts.recipe) die(BAKA_EXIT_CODE.BAD_INPUT, "--recipe <id> is required")
		await runPackTest(name, opts.recipe, opts.input ?? "{}", globals())
	})

packCmd
	.command("edit <name>")
	.description("Open the pack's manifest in $EDITOR, then re-validate")
	.action(async (name) => {
		try {
			await runPackEdit(name, globals())
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.BAD_INPUT, message)
		}
	})

// `baka list-packs` ---------------------------------------------------------

program
	.command("list-packs")
	.description("List packs discovered in this project (tree, project marketplace, user marketplace)")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka://packs` resource)")
	.action(async (opts) => {
		try {
			await runListPacksCommand({ ...globals(), json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka run | slots | fill | serve` (slot-native product path) --------------

program
	.command("run")
	.description("Run a recipe: write its files from templates, filling named slots from values you pass or a model")
	.argument("<recipe>", "a recipe name (add-readme), or pack/recipe when two packs declare the same name")
	.option("--params <json>", "JSON object of recipe params")
	.option("--dry-run", "compute the changeset and output tree hash without writing anything")
	.option(
		"--slot-mode <mode>",
		"live (cache, then model; default), record (always ask the model), replay (records only)",
	)
	.option("--slot-records <file>", "JSON array of slot records, or a receipt whose slots to replay (implies replay)")
	.option(
		"--slot <id=value>",
		"fill a slot yourself (repeatable); needs no model and is not cached",
		(assignment: string, prior: string[]) => [...prior, assignment],
		[] as string[],
	)
	.option("--slots-file <file>", "JSON object of slot id to value; --slot wins over it")
	.option(
		"--on-existing <policy>",
		"what to do with a template target that already exists: skip (default), overwrite, or fail",
	)
	.option("--include-content", "attach each written file's text to its changeset entry")
	.option("--no-validate", "skip the validators (by default a run validates exactly as runRecipe does)")
	.option("--format", "run the formatter the recipe declares over the files the run wrote, before validating")
	.option("--json", "emit machine-readable JSON to stdout (the RecipeResult receipt)")
	.allowUnknownOption()
	.allowExcessArguments(true)
	.action(async (target, opts) => {
		try {
			await runRunCommand(target, {
				...globals(),
				json: opts.json,
				dryRun: opts.dryRun,
				slotMode: opts.slotMode,
				slotRecords: opts.slotRecords,
				slot: opts.slot,
				slotsFile: opts.slotsFile,
				onExisting: opts.onExisting,
				includeContent: opts.includeContent,
				validate: opts.validate,
				format: opts.format,
				params: opts.params,
				extra: process.argv,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("lock")
	.description(
		"Pin packs to their current version and content hash in baka.lock.json; `baka run` then verifies against it",
	)
	.argument("[packs...]", "pack names to pin (default: every discovered pack)")
	.option("--json", "emit machine-readable JSON to stdout")
	.action((packs: string[], opts) => {
		try {
			runLockCommand({ ...globals(), json: opts.json, packs })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("slots")
	.description("List the named slots of a recipe")
	.argument("<recipe>", "a recipe name, or pack/recipe")
	.option("--json", "emit machine-readable JSON to stdout")
	.action(async (target, opts) => {
		try {
			await runSlotsCommand(target, { ...globals(), json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("fill")
	.description("Pin a slot fill (writes the project slot cache; model=manual)")
	.argument("<recipe>", "a recipe name, or pack/recipe")
	.option("--slot <id>", "slot id")
	.option("--value <text>", "fill value (string)")
	.option("--file <path>", "read the fill from a file")
	.option("--params <json>", "JSON object of recipe params (must match the later run)")
	.option("--json", "emit machine-readable JSON to stdout")
	.allowUnknownOption()
	.allowExcessArguments(true)
	.action(async (target, opts) => {
		try {
			await runFillCommand(target, {
				...globals(),
				json: opts.json,
				slot: opts.slot,
				value: opts.value,
				file: opts.file,
				params: opts.params,
				extra: process.argv,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("inspect")
	.description("Show params, named slots, and template source for a recipe")
	.argument("<recipe>", "a recipe name, or pack/recipe")
	.option("--json", "emit machine-readable JSON to stdout")
	.action(async (target, opts) => {
		try {
			await runInspectCommand(target, { ...globals(), json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("serve")
	.description(
		"Serve the engine over HTTP so the desktop (or curl) can call it. Loopback only unless a bearer token is set.",
	)
	.option("--port <n>", "port", "4311")
	.option("--host <addr>", "address to bind; anything but a loopback address requires a token", "127.0.0.1")
	.option(
		"--token <token>",
		"require `Authorization: Bearer <token>` (prefer the BAKA_ENGINE_TOKEN env var: flags show up in ps)",
	)
	.option(
		"--allow-root <dir>",
		"let requests name a project inside <dir> (repeatable; also BAKA_ENGINE_ALLOWED_ROOTS). Without it only the cwd is served",
		(dir: string, prior: string[]) => [...prior, dir],
		[] as string[],
	)
	.option(
		"--allow-origin <origin>",
		"let the web page at this origin (https://host[:port]) call the engine from a browser (repeatable; also BAKA_ENGINE_ALLOWED_ORIGINS). Needs a bearer token",
		(origin: string, prior: string[]) => [...prior, origin],
		[] as string[],
	)
	.action(async (opts) => {
		// The server answers for several projects, so each one's own settings decide when nothing was named.
		await runServeCommand({
			cwd: projectCwd(),
			packDirs: explicitPackDirs(),
			port: Number(opts.port),
			host: opts.host,
			token: opts.token,
			allowRoots: opts.allowRoot,
			allowOrigins: opts.allowOrigin,
		})
	})

// `baka plan` -----------------------------------------------------------------

program
	.command("plan")
	.description("Plan a new feature intent")
	.argument("[intent]", "The feature intent to plan", "Set up core typescript application with default configurations")
	.option("--dry-run", "resolve the plan without saving or executing")
	.option("--save", "persist the plan to .baka/plans/")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka_plan` tool)")
	.action(async (intent, opts) => {
		try {
			await runPlanCommand(intent, {
				...globals(),
				dryRun: opts.dryRun,
				save: opts.save,
				json: opts.json,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka list-plans` -----------------------------------------------------------

program
	.command("list-plans")
	.description("List saved plan files")
	.action(() => {
		const cwd = projectCwd()
		runListPlans(cwd)
	})

// `baka apply <plan-file>` ---------------------------------------------------

program
	.command("apply <plan-file>")
	.description("Apply a saved plan (executes the steps with SAGA compensation)")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka_apply` tool)")
	.action(async (planFile, opts) => {
		try {
			await runApplyCommand(planFile, globals(), { json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka validate` ------------------------------------------------------------

program
	.command("validate")
	.description("Run all pack validators against the current project")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka_validate` tool)")
	.option(
		"-m, --pack <name>",
		"run validators for a single pack only; exits BAKA_EXIT_CODE.BAD_INPUT (1) if the pack is not found",
	)
	.action(async (opts) => {
		try {
			await runValidateCommand(globals(), { json: opts.json, pack: opts.pack })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka install <spec>` ------------------------------------------------------
//
// Architecture §5.1 cli-install: resolves `@scope/name[@version]`
// through the configured registries, downloads + verifies the
// tarball (VAL-DISC-041), extracts into `.baka/packs/`, and
// registers the source. Also accepts the legacy `npm:...`,
// `git:...`, local path, and https URL shapes (unchanged from the
// pre-registry installer). `--user` flips the scope to the user
// marketplace (`${BAKA_HOME:-$HOME/.baka}/packs`, architecture §8
// decisions 32 + 33).

program
	.command("install <spec>")
	.description(
		"Install a pack package. Accepts npm:..., git:..., local paths, https URLs, or registry specs (@<scope>/<name>[@<version>] or <name>[@<version>]).",
	)
	.option("-l, --local", "install to the project scope (default) vs. user scope")
	// biome-ignore lint/suspicious/noTemplateCurlyInString: help text shows shell variable expansion syntax
	.option("-u, --user", "install to the user scope (${BAKA_HOME:-$HOME/.baka}/packs/)")
	.option(
		"-r, --registry <url>",
		"registry base URL for scoped/bare-name resolution (overrides BAKA_REGISTRY_URL and .baka/settings.json)",
	)
	.option(
		"--json",
		"emit machine-readable JSON to stdout (status, scope, name, version, previousVersion, registry, packPath)",
	)
	.action(async (spec, opts) => {
		const cwd = projectCwd()
		const scope = opts.user ? "user" : "project"
		try {
			await runInstallCommand(spec, {
				cwd,
				scope,
				json: opts.json,
				registry: opts.registry,
			})
		} catch (err) {
			if (err instanceof InstallCommandError) {
				process.exit(err.code)
			}
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka uninstall <spec>` ---------------------------------------------------

program
	.command("uninstall <spec>")
	.description("Uninstall a registry-sourced pack (removes the registration and the materialized pack dir)")
	.option("-u, --user", "uninstall from the user scope")
	.option("--json", "emit machine-readable JSON to stdout (status, scope, name, packPath, settingsPath)")
	.action(async (spec, opts) => {
		const cwd = projectCwd()
		const scope = opts.user ? "user" : "project"
		try {
			await runUninstallCommand(spec, { cwd, scope, json: opts.json })
		} catch (err) {
			if (err instanceof InstallCommandError) {
				process.exit(err.code)
			}
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka remove <source>` -----------------------------------------------------
//
// Legacy non-registry remove path. Registry-sourced packs go
// through `baka uninstall` (which carries the same-name collision
// logic + the user-vs-project scope decision). `baka remove`
// strips the raw source string from settings verbatim — it does
// not parse scoped names, so it cannot tell two scoped installs
// apart.

program
	.command("remove <source>")
	.description("Remove a non-registry source string from settings (and from disk if materialized)")
	.option("-u, --user", "remove from the user scope")
	.action((source, opts) => {
		const cwd = projectCwd()
		const scope = opts.user ? "user" : "project"
		try {
			runRemoveCommand(source, { cwd, scope })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka list-packages` -------------------------------------------------------

program
	.command("list-packages")
	.description("List installed pack packages (project + user scopes; project wins on dedup)")
	.action(() => {
		const cwd = projectCwd()
		runListPackagesCommand(cwd)
	})

// `baka search <query>` -----------------------------------------------------

program
	.command("search <query>")
	.description(
		"Search packs across every configured registry (--registry > BAKA_REGISTRY_URL > .baka/settings.json registries list > default localhost:4300). Each hit carries its source `registry` attribution field.",
	)
	.option("-r, --registry <url>", "query a single registry (overrides BAKA_REGISTRY_URL and .baka/settings.json)")
	.option(
		"--json",
		"emit machine-readable JSON to stdout (query, results, warnings; each hit carries its source `registry`)",
	)
	.action(async (query, opts) => {
		const cwd = projectCwd()
		try {
			await runSearchCommand(query, {
				json: opts.json,
				registry: opts.registry,
				cwd,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka registry *` -------------------------------------------------------
//
// Login / logout / whoami for a baka pack registry. Credentials are
// stored per-registry in `${BAKA_HOME:-$HOME/.baka}/config.json` under
// the `registries` section (architecture §8 decisions 4 and 33).

const registryCmd = program.command("registry").description("Authenticate against a baka pack registry")

registryCmd
	.command("login")
	.description("Log in to a registry (opens a browser flow by default; pass --token to paste a key)")
	.option("-t, --token <key>", "use a pre-issued API key instead of opening the browser flow")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.action(async (opts) => {
		try {
			await runRegistryLogin({ token: opts.token, registry: opts.registry })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

registryCmd
	.command("logout")
	.description("Remove the stored credential for a registry")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.action((opts) => {
		try {
			runRegistryLogout({ registry: opts.registry })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

registryCmd
	.command("whoami")
	.description("Print the authenticated identity for a registry")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.action(async (opts) => {
		try {
			await runRegistryWhoami({ registry: opts.registry })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

registryCmd
	.command("list")
	.description("List every registry with a stored credential (apiKey masked)")
	.action(() => {
		try {
			runRegistryList()
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

registryCmd
	.command("info <spec>")
	.description(
		"Show a pack's served manifest, versions, and screening verdict BEFORE install (field-for-field equal to GET /v1/packs/<scope>/<name> + .../<latestVersion>)",
	)
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.option(
		"--json",
		"emit machine-readable JSON to stdout (scope, name, tier, visibility, description, latestVersion, versions[], manifest, screening)",
	)
	.action(async (spec, opts) => {
		try {
			await runRegistryInfo(spec, { registry: opts.registry, json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

registryCmd
	.command("preview <spec>")
	.description(
		"Show the generated-code preview per recipe BEFORE install; `needs-llm` shown honestly for requiresReasoning recipes; explicit 'no preview available' line when the pack has no preview artifacts",
	)
	.option("-a, --recipe <id>", "show only one recipe's preview (byte-equal to GET .../previews/<recipeId>)")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.option(
		"--json",
		"emit machine-readable JSON to stdout (scope, name, version, previews[]; each entry carries state + files + reason)",
	)
	.action(async (spec, opts) => {
		try {
			await runRegistryPreview(spec, {
				registry: opts.registry,
				recipe: opts.recipe,
				json: opts.json,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka publish <repo>@<tag>` ----------------------------------------------------
//
// Thin wrapper over POST /v1/publish + status polling. Architecture
// §5.1, milestone 5 (cli-publish-org). The auth/role gate is the
// registry's; the CLI refuses pre-network when no credential is
// stored (VAL-DISC-007) and surfaces the registry's typed 4xx
// verbatim so the caller can branch on role vs schema failures.

program
	.command("publish <spec>")
	.description("Publish a repo@tag to a registry (polls status, prints the screening verdict)")
	.option("--org <slug>", "target org slug (the registry namespace to publish into; required)")
	.option("--path <dir>", "subdirectory inside the repo containing the pack manifest")
	.option("--visibility <vis>", "pack visibility on the registry: 'org' (private, default) or 'public'")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.option(
		"--json",
		"emit machine-readable JSON to stdout (status, scope, name, version, commitSha, contentHash, screening)",
	)
	.action(async (spec, opts) => {
		try {
			await runPublishCommand(spec, {
				org: opts.org,
				path: opts.path,
				visibility: opts.visibility,
				registry: opts.registry,
				json: opts.json,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

// `baka org create | list | invite` ---------------------------------------
//
// Thin wrappers over /v1/orgs/*. Auth comes from the per-registry
// credential store (same `baka registry login` flow that gates
// `baka publish`); the CLI refuses pre-network when no credential
// is stored so the auth/role contract (VAL-DISC-007, VAL-DISC-008,
// VAL-DISC-014) holds.

const orgCmd = program.command("org").description("Manage the orgs you belong to on the configured registry")

orgCmd
	.command("create <slug>")
	.description("Create a new org (you become its owner)")
	.option("-n, --name <name>", "human-readable org name (defaults to the slug)")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.option("--json", "emit machine-readable JSON to stdout (id, slug, name)")
	.action(async (slug, opts) => {
		try {
			await runOrgCreateCommand(slug, {
				name: opts.name,
				registry: opts.registry,
				json: opts.json,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

orgCmd
	.command("list")
	.description("List every org you belong to (with role)")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.option("--json", "emit machine-readable JSON to stdout (array of { id, slug, name, role })")
	.action(async (opts) => {
		try {
			await runOrgListCommand({ registry: opts.registry, json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

orgCmd
	.command("invite <slug> <email>")
	.description("Invite a user to an org by email with a role (owner, admin, or member)")
	.option("--role <role>", "role to grant (owner | admin | member); defaults to member")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.option("--json", "emit machine-readable JSON to stdout (invitationId, slug, email, role)")
	.action(async (slug, email, opts) => {
		try {
			await runOrgInviteCommand(slug, email, {
				role: opts.role,
				registry: opts.registry,
				json: opts.json,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.FAILED, err instanceof Error ? err.message : String(err))
		}
	})

await program.parseAsync(process.argv)
