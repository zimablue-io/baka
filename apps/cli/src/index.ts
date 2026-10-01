#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { moduleDirsFromEnv } from "@repo/ast-tooling"
import { BAKA_EXIT_CODE } from "@repo/protocol"
import { Command } from "commander"
import { runInit } from "./commands/init"
import { InstallCommandError, runInstallCommand, runUninstallCommand } from "./commands/install"
import { runListPackagesCommand, runRemoveCommand } from "./commands/marketplace"
import { runModuleEdit, runModuleListActions, runModuleTest, runModuleValidate } from "./commands/module"
import { runOrgCreateCommand, runOrgInviteCommand, runOrgListCommand } from "./commands/org"
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
	runListModulesCommand,
	runLockCommand,
	runRunCommand,
	runServeCommand,
	runSlotsCommand,
} from "./commands/run"
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

// A relative --cwd is resolved here, once, so every command sees an absolute project root.
program.option(
	"--cwd <path>",
	"use the given directory as the project root (relative paths resolve against the current directory)",
	(value: string) => resolve(value),
	process.cwd(),
)
// The project root and the module scope are separate: --modules-dir (or BAKA_MODULE_DIRS) names the
// directories modules are drawn from, so a catalog elsewhere can serve any project without symlinks
// and without being written to.
program.option(
	"--modules-dir <path>",
	"directory containing <module>/manifest.ts entries; repeatable, highest precedence first. When given (or BAKA_MODULE_DIRS is set) ONLY these are searched, instead of the project's modules/, .baka/modules, and the user marketplace",
	(value: string, prior: string[]) => [...prior, resolve(value)],
	[] as string[],
)

/** The project root and module directories every command works with: flags first, then BAKA_MODULE_DIRS. */
function globals(): { cwd: string; moduleDirs?: string[] } {
	const opts = program.opts<{ cwd?: string; modulesDir?: string[] }>()
	const moduleDirs = opts.modulesDir?.length ? opts.modulesDir : moduleDirsFromEnv(process.env)
	return { cwd: opts.cwd ?? process.cwd(), moduleDirs }
}

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
	.description("Interactive first-time setup: configure both worker and validator roles")
	.action(async () => {
		try {
			await runInit()
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.USER_ERROR, message)
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
			die(BAKA_EXIT_CODE.USER_ERROR, message)
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
		const cwd = globals().cwd
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
		const cwd = globals().cwd
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
	.action((name, opts) => {
		runModuleValidate(name, { ...globals(), json: opts.json })
	})
moduleCmd
	.command("list-actions <name>")
	.description("Show a module's actions")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka_list_actions` tool)")
	.action((name, opts) => {
		runModuleListActions(name, { ...globals(), json: opts.json })
	})

moduleCmd
	.command("test <name>")
	.description("Run a single action in an isolated temp dir")
	.option("-a, --action <id>", "the action id to run (required)")
	.option("-i, --input <json>", "JSON input for the action", "{}")
	.action(async (name, opts) => {
		if (!opts.action) die(BAKA_EXIT_CODE.USER_ERROR, "--action <id> is required")
		await runModuleTest(name, opts.action, opts.input ?? "{}", globals())
	})

moduleCmd
	.command("edit <name>")
	.description("Open the module's manifest in $EDITOR, then re-validate")
	.action(async (name) => {
		try {
			await runModuleEdit(name, globals())
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("User force closed")) return
			die(BAKA_EXIT_CODE.USER_ERROR, message)
		}
	})

// `baka list-modules` ---------------------------------------------------------

program
	.command("list-modules")
	.description("List modules discovered in this project (tree, project marketplace, user marketplace)")
	.option("--json", "emit machine-readable JSON to stdout (same shape as the baka-mcp `baka://modules` resource)")
	.action(async (opts) => {
		try {
			await runListModulesCommand({ ...globals(), json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka run | slots | fill | serve` (slot-native product path) --------------

program
	.command("run")
	.description("Materialize a named module/action (templates + named slots). Product path; prefer this over plan.")
	.argument("<target>", "module/action (e.g. hello/greet)")
	.option("--params <json>", "JSON object of action params")
	.option("--dry-run", "compute the changeset and output tree hash without writing anything")
	.option(
		"--slot-mode <mode>",
		"live (cache, then model; default), record (always ask the model), replay (records only)",
	)
	.option("--slot-records <file>", "JSON array of slot records, or a receipt whose slots to replay (implies replay)")
	.option(
		"--on-existing <policy>",
		"what to do with a template target that already exists: skip (default), overwrite, or fail",
	)
	.option("--include-content", "attach each written file's text to its changeset entry")
	.option("--no-validate", "skip the validators (by default a run validates exactly as runAction does)")
	.option("--format", "run the formatter the action declares over the files the run wrote, before validating")
	.option("--json", "emit machine-readable JSON to stdout (the ActionResult receipt)")
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
				onExisting: opts.onExisting,
				includeContent: opts.includeContent,
				validate: opts.validate,
				format: opts.format,
				params: opts.params,
				extra: process.argv,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("lock")
	.description(
		"Pin modules to their current version and content hash in baka.lock.json; `baka run` then verifies against it",
	)
	.argument("[modules...]", "module names to pin (default: every discovered module)")
	.option("--json", "emit machine-readable JSON to stdout")
	.action((modules: string[], opts) => {
		try {
			runLockCommand({ ...globals(), json: opts.json, modules })
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("slots")
	.description("List named slots for a module/action")
	.argument("<target>", "module/action")
	.option("--json", "emit machine-readable JSON to stdout")
	.action(async (target, opts) => {
		try {
			await runSlotsCommand(target, { ...globals(), json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("fill")
	.description("Pin a slot fill (writes the project slot cache; model=manual)")
	.argument("<target>", "module/action")
	.option("--slot <id>", "slot id")
	.option("--value <text>", "fill value (string)")
	.option("--file <path>", "read the fill from a file")
	.option("--params <json>", "JSON object of action params (must match the later run)")
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

program
	.command("inspect")
	.description("Show params, named slots, and template source for a module/action")
	.argument("<target>", "module/action")
	.option("--json", "emit machine-readable JSON to stdout")
	.action(async (target, opts) => {
		try {
			await runInspectCommand(target, { ...globals(), json: opts.json })
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
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
	.action(async (opts) => {
		await runServeCommand({
			...globals(),
			port: Number(opts.port),
			host: opts.host,
			token: opts.token,
			allowRoots: opts.allowRoot,
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka list-plans` -----------------------------------------------------------

program
	.command("list-plans")
	.description("List saved plan files")
	.action(() => {
		const cwd = globals().cwd
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
		try {
			await runValidateCommand(globals(), { json: opts.json, module: opts.module })
		} catch (err) {
			die(BAKA_EXIT_CODE.VALIDATION_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka install <spec>` ------------------------------------------------------
//
// Architecture §5.1 cli-install: resolves `@scope/name[@version]`
// through the configured registries, downloads + verifies the
// tarball (VAL-DISC-041), extracts into `.baka/modules/`, and
// registers the source. Also accepts the legacy `npm:...`,
// `git:...`, local path, and https URL shapes (unchanged from the
// pre-registry installer). `--user` flips the scope to the user
// marketplace (`${BAKA_HOME:-$HOME/.baka}/modules`, architecture §8
// decisions 32 + 33).

program
	.command("install <spec>")
	.description(
		"Install a module package. Accepts npm:..., git:..., local paths, https URLs, or registry specs (@<scope>/<name>[@<version>] or <name>[@<version>]).",
	)
	.option("-l, --local", "install to the project scope (default) vs. user scope")
	// biome-ignore lint/suspicious/noTemplateCurlyInString: help text shows shell variable expansion syntax
	.option("-u, --user", "install to the user scope (${BAKA_HOME:-$HOME/.baka}/modules/)")
	.option(
		"-r, --registry <url>",
		"registry base URL for scoped/bare-name resolution (overrides BAKA_REGISTRY_URL and .baka/settings.json)",
	)
	.option(
		"--json",
		"emit machine-readable JSON to stdout (status, scope, name, version, previousVersion, registry, modulePath)",
	)
	.action(async (spec, opts) => {
		const cwd = globals().cwd
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka uninstall <spec>` ---------------------------------------------------

program
	.command("uninstall <spec>")
	.description("Uninstall a registry-sourced module (removes the registration and the materialized module dir)")
	.option("-u, --user", "uninstall from the user scope")
	.option("--json", "emit machine-readable JSON to stdout (status, scope, name, modulePath, settingsPath)")
	.action(async (spec, opts) => {
		const cwd = globals().cwd
		const scope = opts.user ? "user" : "project"
		try {
			await runUninstallCommand(spec, { cwd, scope, json: opts.json })
		} catch (err) {
			if (err instanceof InstallCommandError) {
				process.exit(err.code)
			}
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka remove <source>` -----------------------------------------------------
//
// Legacy non-registry remove path. Registry-sourced modules go
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
		const cwd = globals().cwd
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
		const cwd = globals().cwd
		runListPackagesCommand(cwd)
	})

// `baka search <query>` -----------------------------------------------------

program
	.command("search <query>")
	.description(
		"Search modules across every configured registry (--registry > BAKA_REGISTRY_URL > .baka/settings.json registries list > default localhost:4300). Each hit carries its source `registry` attribution field.",
	)
	.option("-r, --registry <url>", "query a single registry (overrides BAKA_REGISTRY_URL and .baka/settings.json)")
	.option(
		"--json",
		"emit machine-readable JSON to stdout (query, results, warnings; each hit carries its source `registry`)",
	)
	.action(async (query, opts) => {
		const cwd = globals().cwd
		try {
			await runSearchCommand(query, {
				json: opts.json,
				registry: opts.registry,
				cwd,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

// `baka registry *` -------------------------------------------------------
//
// Login / logout / whoami for a baka module registry. Credentials are
// stored per-registry in `${BAKA_HOME:-$HOME/.baka}/config.json` under
// the `registries` section (architecture §8 decisions 4 and 33).

const registryCmd = program.command("registry").description("Authenticate against a baka module registry")

registryCmd
	.command("login")
	.description("Log in to a registry (opens a browser flow by default; pass --token to paste a key)")
	.option("-t, --token <key>", "use a pre-issued API key instead of opening the browser flow")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.action(async (opts) => {
		try {
			await runRegistryLogin({ token: opts.token, registry: opts.registry })
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

registryCmd
	.command("list")
	.description("List every registry with a stored credential (apiKey masked)")
	.action(() => {
		try {
			runRegistryList()
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

registryCmd
	.command("info <spec>")
	.description(
		"Show a module's served manifest, versions, and screening verdict BEFORE install (field-for-field equal to GET /v1/modules/<scope>/<name> + .../<latestVersion>)",
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

registryCmd
	.command("preview <spec>")
	.description(
		"Show the generated-code preview per action BEFORE install; `needs-llm` shown honestly for requiresReasoning actions; explicit 'no preview available' line when the module has no preview artifacts",
	)
	.option("-a, --action <id>", "show only one action's preview (byte-equal to GET .../previews/<actionId>)")
	.option("-r, --registry <url>", "registry base URL (default: BAKA_REGISTRY_URL or http://localhost:4300)")
	.option(
		"--json",
		"emit machine-readable JSON to stdout (scope, name, version, previews[]; each entry carries state + files + reason)",
	)
	.action(async (spec, opts) => {
		try {
			await runRegistryPreview(spec, {
				registry: opts.registry,
				action: opts.action,
				json: opts.json,
			})
		} catch (err) {
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
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
	.option("--path <dir>", "subdirectory inside the repo containing the module manifest")
	.option("--visibility <vis>", "module visibility on the registry: 'org' (private, default) or 'public'")
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
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
			die(BAKA_EXIT_CODE.ENGINE_ERROR, err instanceof Error ? err.message : String(err))
		}
	})

program.parse(process.argv)
