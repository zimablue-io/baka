# Authoring Baka Packs

A **pack** is a self-contained directory that exposes typed, validated recipes to the baka engine. Packs can live in four places:

| Scope | Where it lives | Precedence on dedup |
|---|---|---|
| **project marketplace** | `<project>/.baka/packs/<name>/` | 1 (highest; wins) |
| **in-tree** | `<project>/packs/<name>/` | 2 |
| **user marketplace** | `${BAKA_HOME:-$HOME/.baka}/packs/<name>/` | 3 |
| **bundled** | the `starter` pack, which ships inside every install (`dist/packs/`) | 4 (lowest) |

Discovery walks every scope on every run; there is no registration step, and both real directories and symlinks are accepted. When two scopes provide the same pack name, the first scope in precedence order owns it and the lower-precedence copies are skipped, so a project or user pack named `starter` replaces the bundled one. The bundled scope is always last and always listed: a fresh install in an empty directory has the `starter` pack and nothing else, and `baka run add-readme --name my-app` works with no model and no setup. `--isolated` (or `BAKA_ISOLATED=1`) drops the user marketplace from the search, along with every other read of the user directory (the stored model and the user slot cache); it leaves the project's scopes and the bundled pack in place.

The `starter` pack is the one pack Baka ships: small recipes for everyday files (`add-readme`, `add-gitignore`, `add-mit-license`, `add-editorconfig`, `add-contributing`, `add-security-policy`, `add-node-ci`) and a TypeScript library skeleton (`ts-lib`). Every file is a plain template, so none of them needs a model. Anything larger is a pack you install or write.

### Using a catalog from another directory

The project root (`--cwd`, default the current directory; a relative path resolves against it) is where recipes write and where `baka.lock.json` lives. It is separate from the pack scope. The directories packs are drawn from (each holding `<pack>/manifest.ts` entries) are chosen by, highest precedence first:

1. `--packs-dir <path>` (repeatable, highest precedence first); relative paths resolve against the current directory.
2. The environment variable `BAKA_PACK_DIRS` (paths separated like `PATH`, `:` or `;`); relative paths resolve against the current directory.
3. `packDirs` in the project's `.baka/settings.json`, an array of directories; relative paths resolve against the project root (`--cwd`), absolute paths are used as they are, and the first entry wins a pack name.
4. Nothing given: the default discovery described above (the project's `.baka/packs` and `packs/`, then the user marketplace, then the bundled `starter` pack).

When any of the first three decides, **only** its directories are searched (not the project's `packs/`, `.baka/packs`, the user marketplace, or the bundled `starter` pack), and the lower ones are not read. A project that keeps its catalog in `.baka/settings.json` therefore gets the same packs from a bare `baka validate` on every machine, whatever sits in `~/.baka`:

```json
{
	"packDirs": ["../baka-packs/packs"]
}
```

The setting is checked when a command starts. A listed directory that does not exist (or is a file) ends the command with exit code 2 (bad input) and a message naming the file, the entry, where it resolved, and the fix (create the directory, correct the entry, or remove it); a settings file that is not valid JSON, or a `packDirs` that is not an array of non-empty strings, is refused the same way. It is never a silent empty catalog. An empty list means the setting is absent. Other keys of the file (`packages`, `registries`) are kept when `baka install` and `baka uninstall` rewrite it.

A catalog repo can therefore serve any project with no symlinks and is never written to:

```bash
baka --cwd ~/code/my-app --packs-dir ~/code/baka-packs/packs run ts-package/scaffold --name ui
BAKA_PACK_DIRS=~/code/baka-packs/packs baka --cwd ~/code/my-app validate
```

It applies to every command that reads packs (`run`, `slots`, `fill`, `inspect`, `list-packs`, `lock`, `validate`, `plan`, `apply`, `pack validate|list-recipes|test|edit`), to the MCP server (`BAKA_PACK_DIRS`, then the settings of its working directory), and to `baka serve` and `baka-engine`: `--packs-dir` and `BAKA_PACK_DIRS` apply to every project the server answers for, and without them each project's own `packDirs` decides. Commands that do not read packs (`install`, `uninstall`, `search`, `registry`, `list-packages`) do not look at the setting. From the library, read the same chain with `resolvePackDirs({ root, flag, env })` (or `packDirsFromSettings(root)`) and build the registry with `createRegistry({ root, packDirs })`.

`scripts/baka.mjs` (what `pnpm baka` runs) works from any directory: `node /path/to/baka/scripts/baka.mjs --cwd . run ...`.

Install a pack into the project marketplace with `baka install <source>` (links it under `<project>/.baka/packs/`); add `--user` to install into the user marketplace instead. Sources can be `npm:@scope/pkg[@ver]`, `git:host/repo[@ref]`, `https://...`, `/abs/path`, or `./rel/path`.

## Layout

```
packs/<my-pack>/
  package.json         # self-contained; baka-sdk (types only) as a devDependency, peer-deps on baka
  tsconfig.json        # extends your TS base; maps "baka-sdk" to a real path (types)
  README.md            # recommended; its absence is a `baka pack validate` warning
  manifest.ts          # exports `Manifest` (typed via PackManifestSchema)
  scaffold/
    recipe.ts          # the recipe implementation
    templates/         # required if requiresReasoning: true
    validators/<id>.ts # one kebab-case file per rule declared in manifest
  add-script/
    recipe.ts
  data/
    <name>.json        # read-only data, exposed as `data.<name>` (see "Pack data")
  _shared/
    helpers/<name>.ts  # ordinary TS packs, imported via relative paths
    validators/<id>.ts # pack-level validators (whole-pack checks)
```

The engine enforces the layout. `recipe.ts` may be omitted when `templates/` is the output tree. Missing both produces a `recipe-missing` diagnostic.

The pack must be **self-contained**: `baka pack test` copies the pack (including its `node_modules`) into a temp dir and runs the recipe from that copy, so anything the pack imports at run time must resolve from inside it. Types from `baka-sdk` are erased and need no install.

## Public boundary: `baka-sdk`

Packs import only from `baka-sdk` (not from `@repo/protocol` or the engine internals), and **only types**. `baka-sdk` is not installed next to a pack and the engine does not alias it at run time, so a runtime import (`import { AgentRole } from "baka-sdk"`, a bare `import "baka-sdk"`, `require("baka-sdk")`) fails to load in any catalog without its own `node_modules`. Write `import type { ... } from "baka-sdk"` everywhere: jiti erases it, and the pack type-checks against the SDK (or a copy of its `.d.ts`) without Baka being installed. `baka pack validate` scans a pack's TypeScript files (everything under the pack root except `node_modules`, test and `types` directories, `*.d.ts`, and `*.test.ts`) and fails on a runtime import of `baka-sdk`, naming the file and line; `import type { A } from "baka-sdk"` and `import { type A } from "baka-sdk"` are both accepted.

The one opt-out is to own the install: a pack that really needs a runtime export (for example `callLLMAsValidator` in a validator) lists `baka-sdk` under `dependencies` in its `package.json` and installs it; `pack validate` then accepts runtime imports, and `baka pack test` copies the pack's `node_modules` along. A catalog that does this gives up running straight from a fresh clone.

A `recipe.ts` therefore exports an `RecipeStep`, which has no `role` (the one runtime value a step used to need, `AgentRole.WORKER`, is gone):

```ts
import type { RecipeStep } from "baka-sdk"
```

`baka-sdk` exports the public types you need (`RecipeStep`, `RecipeContext`, `RecipeFiles`, `OrchestrationState`, `PackManifest`, `ValidationDiagnostic`, ...). If you need something that isn't there, it almost certainly shouldn't be in a pack - it should be in the engine.

## A complete example pack

Everything below is copy-pasteable: a pack built from these exact files passes `baka pack validate` and runs under `baka pack test`.

### `packs/hello-mod/manifest.ts`

The manifest must export a `Manifest` value matching `PackManifestSchema`. Validator ids are camelCase here; the validator files on disk are the kebab-case form of the same id.

```ts
import type { PackManifest } from "baka-sdk"

export const Manifest: PackManifest = {
	name: "hello-mod",
	version: "0.1.0",
	description: "Writes a greeting file into the target project.",
	dependencies: [],
	conflictsWith: [],
	recipes: [
		{
			id: "say-hello",
			description: "Write hello.txt containing a greeting.",
			requiresReasoning: false,
			filePatterns: ["hello.txt"],
			validators: ["hasGreeting"],
			params: [{ name: "name", type: "string", required: true, description: "Who to greet." }],
		},
	],
	packValidators: [],
}
```

### Recipe fields

| Field | Meaning |
|---|---|
| `id`, `description`, `params` | Identity and the declared params (see "Param types"). |
| `requiresReasoning` | The recipe has named slots a model fills. |
| `compensatesWith` | The id of the inverse recipe. |
| `filePatterns` | The files the recipe is expected to write. |
| `validators` | Ids of recipe-level validators (see "Validators"). |
| `marker` | Glob patterns that let `baka validate` recognise the recipe's output so its validators run (see "Validators"). |
| `supportsDryRun` | A `recipe.ts` recipe that writes only through `ctx.files` in a dry run (see "The `recipe.ts` contract"). |
| `format` | `{ command, args }`: the formatter for the files this recipe generates (see "Formatting generated output"). |
| `toolchain` | `"tsc"`: the registry's screening layer type-checks the dry-run output. |

### `packs/hello-mod/say-hello/recipe.ts`

A recipe is an `RecipeStep` object: `execute` writes files through `ctx.files` (contained to the project, honouring `onExisting`, virtual in a dry run) and returns a `StepResponse`; `compensate` undoes whatever `execute` did by means the engine cannot see (the engine itself undoes `ctx.files` writes, template files, and the directories it created). The full contract is in "The `recipe.ts` contract" below.

The loader resolves the recipe by export name, in this order: `camelCase(id)`, `camelCase(id)` + `Recipe`, the exact id, id + `Recipe`, then the default export. For the id `say-hello`, the export `sayHello` or `sayHelloRecipe` resolves; the example uses `sayHelloRecipe`.

```ts
import type { RecipeStep } from "baka-sdk"

interface SayHelloInput {
	name: string
}

export const sayHelloRecipe: RecipeStep<SayHelloInput, string, null> = {
	name: "hello-mod.say-hello",

	execute: async (input, _state, ctx) => {
		const written = ctx.files.write("hello.txt", `hello ${input.name}\n`)
		return { success: true, output: written.op, compensationData: null }
	},

	// Nothing to undo that the engine does not already undo.
	compensate: async () => {},
}
```

## The `recipe.ts` contract

A recipe with a `recipe.ts` runs after its templates (if any) are written. `execute(params, state, ctx)` receives the **normalized params** (defaults applied, constraints checked), an `OrchestrationState` whose `targetDirectory` is the project root, and an `RecipeContext`:

| `ctx` field | Meaning |
|---|---|
| `onExisting` | The run's policy (`skip` default, `overwrite`, `fail`). `ctx.files.write` applies it; a recipe that writes by other means must honour it itself. |
| `dryRun` | True in a dry run (see below). |
| `files` | The contained file API: `exists(path)`, `readText(path)`, `write(path, content, { onExisting? })`, `remove(path)`, `own(...paths)`. |
| `pack` | `{ name, version, root }` of the running pack (read-only; never write into `root`). |
| `projectRoot` | The project root (same as `state.targetDirectory`). |
| `llmProvider` | The injected provider or null. |

`compensate(data, state, ctx)` gets the same context.

**`ctx.files`.** Paths are project-relative POSIX paths and are contained (see "Path containment"): an escaping path throws, the run fails with `path-escape`, and everything written so far is undone. `write` creates parent directories and answers `{ path, op, contentHash }`:

- the file does not exist: written, `create`;
- it holds exactly these bytes: not touched, `unchanged` (whatever the policy, except `fail`);
- it holds other bytes: `skip` leaves it (`skip`), `overwrite` rewrites it (`update`), `fail` throws `target-exists`.

Every call is journalled, so the engine can undo it, and reported in the changeset judged against what was there when the recipe first touched the path (so a file written twice is one `create`). `own("path")` declares a file the recipe produces by other means (a spawned tool, a direct `node:fs` write): if it exists afterwards and did not change it is listed as `unchanged`, which is what keeps a rerun's `outputTreeHash` equal to the first run's for such files.

**What the engine does around `execute`.** It hashes the project tree before and after (skipping `.git/`, `node_modules/`, and the root `.baka/`). Files the recipe created by any means, and directories it created, are therefore known: they go into `compensation.created` / `createdDirs`, and into the changeset as `create`, `update`, or `delete`. Only `ctx.files` also gives previous bytes (restorable) and `unchanged` entries.

**Failure is compensated by the engine.** If `execute` throws, or returns `success: false`, the engine (1) calls the recipe's `compensate` with the `compensationData` it returned (not when it threw: there is no data), (2) deletes every file the run created (templates, `ctx.files`, plain `node:fs`), (3) restores every file overwritten through templates or `ctx.files`, (4) removes the directories the run created. Files a recipe modified behind the API's back cannot be restored (the engine never had their bytes); the receipt then carries a `rollback-incomplete` warning naming them. The failed run's changeset is empty and its single error diagnostic is `recipe-failed`, or the code of the engine error (`path-escape`, `target-exists`) that `ctx.files` threw.

**Dry run.** `ctx.dryRun` is true when the caller asked for one. A recipe may only run in a dry run if its manifest recipe sets `supportsDryRun: true`; otherwise the run fails with `dry-run-unsupported`, exactly as before. A dry-runnable recipe promises to write only through `ctx.files` (which then act on a virtual tree: reads see the template files the run planned and the recipe's own earlier writes, the disk is never touched) and to spawn nothing. Baka checks the promise by hashing the tree before and after; a recipe that changed it anyway fails with `dry-run-violation` (anything it created is removed, anything it modified is named in the message). The receipt of a dry run has the same changeset and `outputTreeHash` a real run on the same tree would produce.

```ts
export const Manifest = {
	// ...
	recipes: [{ id: "scaffold", supportsDryRun: true, /* ... */ }],
}
```

**What is not covered.** `recipe.ts` is code, and plain `node:fs` and `child_process` calls are outside anything Baka can contain. Pins (`baka.lock.json`) say which code ran; `ctx.files` is the way to get containment, `unchanged` reporting, dry runs and automatic rollback.

## Validators

A pack can declare two kinds of validators. Both are plain async functions of the `OrchestrationState` that return `ValidationDiagnostic[]` (an empty array means pass). The manifest references the validator by its camelCase id; the file on disk is the kebab-case form (`hasGreeting` -> `has-greeting.ts`) and must export a function named with the camelCase id.

### What a validator receives: `state.run`

`state.targetDirectory` is the project root. `state.run` (a `ValidatorRun`) says which recipe run the validator is judging:

| `state.run` field | Meaning |
|---|---|
| `pack`, `recipe` | The recipe. |
| `ran` | True when the recipe ran in this invocation; false when `baka validate` found its output through a `marker` (below). |
| `params` | The params the recipe ran with, normalized (defaults applied). Empty when `ran` is false. |
| `compensationData` | What the recipe's `execute` returned as compensation data; for a template-only recipe `{ written: [paths] }`. Null when `ran` is false. |
| `output` | What the recipe's `execute` returned as output; null for template-only recipes and when `ran` is false. |
| `changeset` | The run's changeset (`create` / `update` / `unchanged` / `skip` / `delete` entries). Empty when `ran` is false. |
| `detected` | When `ran` is false: the project paths the marker matched. |

`state.run` is undefined for a pack-level validator under `baka validate`.

### Which validators run

- **After a run** (`runRecipe`, `baka run`, the MCP `baka_run` tool, `POST /v1/run`): the pack-level validators of the pack, and the validators of **the recipe that ran**, nothing else. A sibling recipe's validators and other packs are not touched. Pack-level validators see the same `state.run` (the recipe that triggered them). `baka run` validates by default exactly as `runRecipe` does (`--no-validate`, or `validate: false`, skips it); a dry run never validates.
- **After `baka apply`**: for each completed step, as above (pack-level validators once per pack, with `state.run` of the last step of that pack).
- **`baka validate [-m <pack>]`** runs no recipe. It runs pack-level validators (`state.run` undefined), plus a recipe's validators only for recipes whose output it can detect: a recipe that declares a `marker` in its manifest, a list of glob patterns relative to the project root (`*` within a segment, `**` across segments, `?`), e.g. `marker: ["packages/*/package.json"]`. If any project file matches, the recipe's validators run once with `state.run.ran === false` and `state.run.detected` listing the matches. A recipe without a marker has its validators run only after it ran.

Structural problems found at discovery (a missing validator file, a broken manifest) are reported only for the packs in scope: a sibling pack's `recipe-validator-missing` does not fail an unrelated pack's run, but does fail `baka validate` over the whole project.

### Diagnostics

Every diagnostic a validator returns is reported in the receipt's `diagnostics`, **warnings included, whether or not validation passes**; `ok` is false only when one is an `error`. Baka does not rewrite the validator's `rule`: it is whatever the validator set (the validator's own id stands in when it set none). Baka adds `validator`, the namespaced id of the validator that produced it: `<pack>:<id>` for a pack-level validator, `<pack>.<recipe>:<id>` for a recipe-level one. A validator that throws is reported as an error with `rule: "validator-error"` and its `validator` set.

### Pack-level (`_shared/validators/<kebab-id>.ts`)

Run once per validation pass. Inspect any file in the project. Use for cross-cutting rules ("no `console.log` in production code").

```ts
// manifest.ts → packValidators: ["hasPackageJson"]
// _shared/validators/has-package-json.ts
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState, ValidationDiagnostic } from "baka-sdk"

export async function hasPackageJson(state: OrchestrationState): Promise<ValidationDiagnostic[]> {
	const path = join(state.targetDirectory, "package.json")
	if (!existsSync(path)) {
		return [{ severity: "error", rule: "has-package-json", message: `package.json not found at ${path}` }]
	}
	return []
}
```

### Recipe-level (`<recipe>/validators/<kebab-id>.ts`)

Run when the recipe ran (or, under `baka validate`, when its marker matches). Use `state.run` to check what the recipe produced:

```ts
// manifest.ts → recipes: [{ id: "say-hello", validators: ["hasGreeting"], marker: ["hello.txt"], ... }]
// say-hello/validators/has-greeting.ts
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState, ValidationDiagnostic } from "baka-sdk"

export async function hasGreeting(state: OrchestrationState): Promise<ValidationDiagnostic[]> {
	const file = join(state.targetDirectory, "hello.txt")
	if (!existsSync(file)) {
		return [{ severity: "error", rule: "has-greeting", message: `say-hello produced no hello.txt at ${file}` }]
	}
	const text = readFileSync(file, "utf-8")
	if (state.run?.ran && !text.startsWith(`hello ${String(state.run.params.name)}`)) {
		return [{ severity: "warning", rule: "has-greeting", message: `${file} does not greet ${String(state.run.params.name)}` }]
	}
	return []
}
```

Keep validators deterministic TypeScript. A validator that must judge semantic content can ask the validator-role model with `callLLMAsValidator`, a runtime export of `baka-sdk`: that needs the pack to own its `baka-sdk` install (see "Public boundary").

## Shared helpers

A helper is an ordinary TypeScript module under `_shared/helpers/<name>.ts`. Recipes import it with a plain relative import:

```ts
import { readJsonSafe } from "../_shared/helpers/read-json-safe"
```

Use this for code that several recipes share (parsing package.json, walking the dep tree, etc.) without duplicating logic.

## Reasoning recipes

If `requiresReasoning: true`, the LLM is shown a prompt that includes the recipe's `templates/` folder. Drop handlebars templates in there, and the engine will ask the LLM to think through them before producing its plan. Use this for recipes where the LLM needs structured guidance ("here's a checklist of things to consider when scaffolding...").

## Listing and validating

```sh
baka list-packs                 # walks all four scopes
baka pack validate <name>       # schema + layout check + loadability gate (every declared recipe and validator must import through the engine's loader)
baka validate                     # pack-level validators, plus recipe validators whose marker matches
```

## Lifecycle of a published pack

1. `baka pack create <name>` to design a new pack through the chat-driven double-diamond flow
2. Review the LLM's design, refine via chat, and let the consistency test validate it
3. `baka pack test <name> --recipe=<id> --input='<json>'` to run any one recipe in a scratch dir
4. Push the repo to a public Git host
5. Users install it with `baka install git:github.com/you/<name>`

## Chat-driven pack creation (the `baka pack create` flow)

The baka CLI includes a chat REPL that drives a full **double-diamond** design process for your pack. The LLM proposes; you refine. State is saved after every turn, so you can `/exit` and resume at any time.

```sh
baka pack create <name>   # enter the design chat
```

You will be asked for a one-sentence brief of what the pack does, then the LLM takes over. The flow has four phases, and the LLM drives transitions via a `phase` field in its response.

### Phases

| Phase | What happens | What the LLM does |
|---|---|---|
| **DISCOVER** | The LLM asks 3-6 clarifying questions per turn about your domain, conventions, and anti-patterns. | Asks; then writes a `PREFERENCES.md` draft when the answers are clear. |
| **DEFINE** | The LLM proposes a recipe roster (3-10 recipes with id, description, rationale). | Proposes; you curate. |
| **DEVELOP** | For each recipe: param schema, `requiresReasoning`, `compensatesWith`, validators, and (if reasoning) handlebars template outlines. | Designs; you refine. |
| **DELIVER** | The CLI writes the files, runs `baka pack validate`, and runs a **5x consistency test** (the same intent, planned and applied five times; all five must produce identical file trees, identical SHA-256 hashes, and identical plan shapes). | Writes the README summary. |

You type free-form replies at the `> ` prompt. The CLI maintains the full chat history and the LLM sees it on every turn. On `/skip` (or when the LLM signals `finished: true`), the phase advances.

### Slash commands

The REPL intercepts any input that starts with `/`. Available commands:

| Command | Effect |
|---|---|
| `/help` | Show all commands |
| `/save` | Save state to `packs/<name>/.design-state.json` (also auto-saved on every turn) |
| `/show prefs` | Render the current `PREFERENCES.md` |
| `/show recipes` | Render the recipe roster |
| `/show <recipe-id>` | Render the design for one recipe |
| `/rewind` | Pop the last turn and re-ask the LLM |
| `/back <phase>` | Jump back to `DISCOVER`/`DEFINE`/`DEVELOP`/`DELIVER` |
| `/skip` | Accept the LLM's current proposal and advance the phase |
| `/consistency [n] [intent]` | Run the 5x consistency test now (any phase) |
| `/exit` | Save and quit; resume with `baka pack create <name>` |

### Re-running the consistency test on an existing pack

```sh
baka pack consistency <name> --recipe=<id> --intent="<test intent>" --n=5
```

Output includes the per-run trace, the divergences (if any), and the path to a `CONSISTENCY-TRACE.json` file with the full SHA-256 manifest.

### PREFERENCES.md and the planning prompt

`PREFERENCES.md` is the user's preferences for this pack. The orchestrator reads it on every plan that uses this pack, and inlines a "Pack-specific preferences" section into the system prompt. This is the mechanism that makes the user's design choices sticky: the LLM that plans future agents' recipes will honor the conventions you set here, not invent new ones.

The CLI writes `PREFERENCES.md` with YAML frontmatter:

```yaml
---
pack: my-mod
generatedAt: 2026-06-15
---

## Domain
...

## Conventions
- ...

## Anti-patterns
- ...

## Examples
- ...
```

You can edit this file directly with `baka pack edit <name>` and the next plan that touches this pack will use the new content.

### State file

`packs/<name>/.design-state.json` is the chat history + the LLM's last response + the phase + the roster + the designed recipes. Auto-saved on every turn. The state file is **gitignored by convention** (add it to your `.gitignore` if you don't want it tracked):

```gitignore
packs/*/.design-state.json
```

### Why a 5x consistency test?

A pack's contract is "if the LLM plans recipe X with these params, the recipe will produce these files with these contents". If the recipe's body has a non-deterministic bug (e.g. depends on a non-seeded RNG, or has an off-by-one that the LLM's plan sometimes hides), the plan can succeed but the run can drift across invocations. The 5x consistency test catches that drift at pack creation time, so you see the problem while you still have context. If the test fails, the CLI sends you back to DEVELOP with the divergence trace as the LLM's user-message; the LLM uses the trace to refine the recipe's params or validators.

The arxiv literature on LLM agent reproducibility (Measuring Determinism in LLM Code Generation; How Consistent Are LLM Agents) explicitly calls out repeated-run variance and recommends N≥5 to be statistically meaningful. We use exact hash equality because the orchestrator already runs at temperature 0.0.

## Running a recipe: the receipt

`baka run <pack>/<recipe> --json`, the `baka_run` MCP tool, `POST /v1/run`, and `runRecipe` from `@baka/core` all return the same JSON, an `RecipeResult`:

```jsonc
{
  "ok": true,
  "pack": "hello",
  "recipe": "greet",
  "params": { "name": "Ada" },  // the params the run used: defaults applied, scalars coerced
  "diagnostics": [],            // error diagnostics, then validator output (warnings included)
  "changeset": [                // one entry per path the recipe addressed, sorted by path
    { "path": "hello.md", "op": "create", "contentHash": "<sha256 hex>" }
  ],
  "outputTreeHash": "<sha256 hex>",
  "slots": [ /* the slot fills, see "Slot records and replay" */ ],
  "compensation": { "created": ["hello.md"], "createdDirs": [], "overwritten": [], "recipeData": { "written": ["hello.md"] } },
  "output": null,               // what a side-effect recipe.ts returned, else null
  "dryRun": false
}
```

`ok` is false when any diagnostic has `severity: "error"`. A run that fails while executing (a template error, a missing slot, a `recipe.ts` that reports failure) leaves nothing behind: files it created are removed, files it overwrote are restored, directories it created are removed, the changeset is empty, and the one error diagnostic carries a stable code in `rule` (`pack-not-found`, `recipe-not-found`, `recipe-empty`, `invalid-params`, `slots-open`, `slot-provider-error`, `slot-record-missing`, `slot-record-stale`, `slot-fill-invalid`, `template-invalid`, `path-escape`, `dry-run-unsupported`, `recipe-failed`, `unexpected`). A run whose validators fail is different: the files stay, `ok` is false, and `compensation` still describes everything written so the caller can undo it with `compensateRecipe`.

### Changeset

Each entry is `{ path, op, contentHash, reason?, mode? }` (`mode` only when a template or `ctx.files.write` declared permission bits). `path` is project-relative, POSIX-separated, with no leading `./`. `contentHash` is the sha256 (lowercase hex) of the file's bytes after the run, or `null` for a delete.

| `op` | Meaning |
|---|---|
| `create` | The file did not exist; it was written. |
| `update` | The file existed with other content and was rewritten. |
| `delete` | The file existed before and is gone after (side-effect recipes only). |
| `unchanged` | The file already held exactly the bytes the recipe would write (`reason: "identical"`). |
| `skip` | The file exists with other content and was left alone (`reason: "already-exists"`). |

For template files the entries come straight from the plan, so they are exact. A recipe with a `recipe.ts` can do anything, so what it did is the union of the `ctx.files` journal and a diff of the project tree hashed before and after it runs (skipping `.git/`, `node_modules/`, and the root `.baka/`); the result is merged into the template entries (a path the templates already addressed keeps its op, a created file the recipe then edited is still a `create`, and a file the recipe found `unchanged` leaves the template's account alone). `includeContent` (`--include-content`, `includeContent: true`) adds each written file's UTF-8 text as `content` on `create`, `update`, and `unchanged` entries.

### outputTreeHash

`outputTreeHash` identifies the tree a recipe **owns**. The owned set is every file the recipe addressed, whether it produced it or found it already there unchanged:

- each template target: `create`, `update`, `unchanged` (identical bytes already there), or `skip` (other bytes, left alone: the hash then covers what is on disk);
- each file a `recipe.ts` wrote or removed through `ctx.files`, with the same four outcomes (a file it removed is `delete`);
- each file it declared with `ctx.files.own(...)` that exists afterwards;
- each file its `execute` created, changed, or deleted by any other means (found by hashing the tree around it).

A rerun over a tree that already holds the recipe's output therefore lists the same paths with the same content hashes (as `unchanged`), and has **the same `outputTreeHash`** as the first run: the changeset is the owned set, not just the changes. The one gap is a file a `recipe.ts` writes with plain `node:fs` and does not `own`: it is visible only on the run where it changes.

The hash is the sha256 (lowercase hex) of this UTF-8 text:

```
workspace.tree.v1\n
<path>\0<contentHash>\n          one line per changeset entry
<path>\0<contentHash>\0<mode>\n   ... for an entry that declares a mode (see "Conditional files and file modes")
```

- Lines are sorted ascending by the UTF-8 bytes of `<path>` (not by JS string order).
- `<contentHash>` is the entry's `contentHash`, or the literal `deleted` when it is null.
- The `op` and `reason` are not part of the hash. A first run that `create`s two files and a rerun that finds both `unchanged` therefore hash the same, while a rerun that finds one of them `skip`ped with different content hashes differently: the hash covers the bytes on disk, which is the tree you actually have.
- An empty changeset hashes the text `workspace.tree.v1\n`.

### Dry run

`dryRun: true` (`baka run --dry-run`) plans and returns the same receipt without writing anything: no project files and no slot-cache entries. The tree it reports is the tree a real run would leave, given the same slot fills. Template-only recipes are always dry-runnable. A recipe with a `recipe.ts` is dry-runnable if its manifest sets `supportsDryRun` and it writes through `ctx.files` (see "The `recipe.ts` contract"); any other recipe fails with `dry-run-unsupported` rather than pretending. Validators inspect the real tree, so a dry run does not run them. Because a dry run does not persist fills, hand its `slots` to the real run (see "Slot records and replay") when the real run must produce the tree the dry run predicted.

## Formatting generated output

Generated code that a formatter would rewrite makes `biome ci` fail on a fresh tree. Two things make output formatter-stable by construction:

1. **Declare the formatter in the manifest**, per recipe:

   ```ts
   recipes: [{
   	id: "add-schema",
   	// ...
   	format: { command: "biome", args: ["format", "--write", "{files}"] },
   }]
   ```

   `command` is an executable (resolved through `PATH`, with the project's `node_modules/.bin` first, so a formatter installed in the generated project is found); `{files}` in `args` expands to one argument per file the run **created or updated** (project-relative; unchanged and skipped files are not passed), or the files are appended if there is no `{files}`. The command runs from the project root.

2. **Choose who runs it.** Baka never runs a pack's command unasked. `runRecipe({ format: true })`, `baka run <pack>/<recipe> --format`, the MCP `baka_run` tool's `format`, and `POST /v1/run`'s `format` run it after the templates and `recipe.ts` finished and before validation; the receipt then holds the hashes of the formatted bytes. The catalog (`describePacks`, `baka list-packs --json`) lists each recipe's `format`, so a caller that prefers to run the formatter itself (a pre-commit step, a wider `biome check --write`) can. A formatter that cannot start, times out (two minutes), or exits non-zero fails the run with `format-failed` and the run is rolled back like any other failure, with the formatter's last output lines in the message. A dry run cannot format (`dry-run-unsupported`): the files do not exist.

A formatted file is not the template's bytes, so a rerun compares the template against formatted bytes. If the template is formatter-stable (formatting changes nothing) the rerun is `unchanged`; if not, the rerun reports `skip` (under the default policy) and, because the receipt hashes the bytes on disk, still has the first run's `outputTreeHash`. Use `--format` with a rerun as the test of whether a template is formatter-stable: it is exactly when every entry is `unchanged`.

**Biome and `.baka`.** Baka keeps run state under the project's `.baka/` (the slot cache, saved plans, evidence). Generated projects that run Biome should exclude it, or Biome lints and formats those files. In `biome.json` (Biome 2):

```json
{ "files": { "includes": ["**", "!**/.baka"] } }
```

A pack that generates a `biome.json` should ship this line (and `.baka` in `.gitignore` unless the project commits its slots).

## Template language

Every `.hbs` file under `<recipe>/templates/` is one output file: its path under `templates/`, minus `.hbs`, is the output path (itself a template: `{{dir}}/{{name}}/README.md.hbs`). The language is a deliberately small Handlebars subset, checked on the parsed template and failing closed: anything outside it fails the run with `template-invalid`, naming the construct.

| Allowed | Notes |
|---|---|
| `{{param}}`, `{{data.versions.pnpm}}`, `{{this}}`, `{{@index}}` | A plain path. No literals, no sub-expressions. A missing value renders as empty. |
| `{{#if x}}...{{else}}...{{/if}}`, `{{#each xs}}...{{/each}}` | One path argument, no options, no block params. `{{else if y}}` chains. |
| `{{json x}}`, `{{jsonEscape x}}` | The only helpers; exactly one path argument. See "JSON escaping". |
| `{{#slot "id" kind="..." max=N}}hint{{/slot}}` | A named hole the model fills; see "Slot records and replay". |
| `{{!-- comment --}}`, `~` whitespace control | |

Everything else is rejected: triple-stash `{{{x}}}` and `{{&x}}`, partials, decorators, raw blocks, sub-expressions, `with`, `unless`, `lookup`, `log`, any other helper, any other block. (`{{log}}` and `{{lookup}}` are plain parameter names here, not helpers.) The check applies to output paths as well as file bodies.

Params are never evaluated as templates: a param value or a slot fill containing `{{` is written out literally.

### Conditional files and file modes

A template may start with a directive on its **first line**, a comment that never reaches the output:

```hbs
{{!-- @baka when="vitest" mode="0755" --}}
#!/bin/sh
```

- `when` makes the file conditional. The file is written only if the expression holds for the params; otherwise it is not part of the run (not planned, not in the changeset, and its slots are never filled, so no model is asked). Expressions: `name` (truthy), `!name`, `name=value`, `name!=value`, with dotted paths (`owner.login`, `data.features.strict`) and an optional single-quoted value (`kind='lib'`). Truthiness is Handlebars' `if`: `false`, `0`, `""`, `null`, `undefined`, and `[]` are false. Equality compares the value's string form (`vitest=true` works on a boolean). `name=value` is false when `name` is missing, `name!=value` true.
- `mode` is the file's permission bits: three or four octal digits (`"0755"`; setuid, setgid, and sticky bits are refused). The engine applies them with `chmod` after writing, so the umask does not matter. The mode is part of the file's identity: the changeset entry carries `mode` (`"0755"`), and when an entry has one its line in `outputTreeHash` becomes `<path>\0<contentHash>\0<mode>\n` (entries without a mode hash exactly as before). A rerun finds the file `unchanged` only if bytes and bits both match; with identical bytes but other bits `skip` leaves it (reporting the actual bits, `reason: "already-exists"`) and `overwrite` fixes it (`update`; the previous bits go into `compensation.overwritten[].mode` so a rollback restores them). `ctx.files.write(path, content, { mode: "0755" })` has the same semantics.

Keys other than `when` and `mode`, a repeated key, a malformed expression, and a directive that is not on the first line are all `template-invalid`.

### Literal braces

`\{{` writes a literal `{{`, so generated code can contain braces: `style=\{{ color: '{{name}}' }}` renders `style={{ color: 'red' }}`. Only the opener needs the escape; the `}}` that follows is plain text. (`\\{{name}}` is not an escape: it is a backslash followed by an interpolation.) Templates may not contain the private-use characters U+E000 and U+E001, which the engine uses internally.

### JSON escaping

`{{json x}}` writes `x` as a JSON literal (a string with its quotes, a number, a boolean, an array or object; a missing value is `null`), and `{{jsonEscape x}}` writes the body of a JSON string without the quotes, for embedding in a string you wrote yourself:

```hbs
{
  "name": {{json name}},
  "description": "Package for {{jsonEscape name}}",
  "keywords": {{json keywords}}
}
```

Nothing else HTML- or JSON-escapes a value; interpolation is raw text.

### Pack data

Files `data/<name>.json` directly under the pack root are parsed and exposed read-only as `data.<name>`: `data/versions.json` is `{{data.versions.pnpm}}` in a template (and in `when` and output paths) and `ctx.data.versions.pnpm` in a `recipe.ts`. The object is deeply frozen. One copy of shared pins therefore lives in the pack, not duplicated into `_shared/` with a drift test. Other files and subdirectories of `data/` are ignored; a file that is not valid JSON, or whose name does not match `[A-Za-z0-9][A-Za-z0-9_-]*`, makes the pack invalid (`pack-invalid`). The files are part of the pack's content hash, so the pin in `baka.lock.json` covers them. `data` is a reserved param name. Data is not shown to the slot model (slot fills depend on the params only).

## Path containment

Everything Baka writes, and everything it deletes on rollback, stays inside the project root. A path is checked in two steps, before the first byte of a run is written and again right before each write:

1. **Lexical.** The path must be a non-empty POSIX string without backslashes, NUL or other control characters; it must not be absolute (`/x`, `C:x`); it must contain no `..` segment (even one that would come back inside, like `a/../b`); it must not name the root itself; it must not go through a `.git` directory at any depth or start in the root's `.baka/` (those hold hooks and installed packs, which are code that runs later).
2. **Resolution.** After resolving symbolic links, the deepest existing ancestor of the target must lie inside the root's real path, and the target itself must not be a symbolic link (a write must not land on the file the link points at).

A violation fails the run with `path-escape`, before anything is written, so the changeset is empty and nothing is left to undo. This covers:

- template output paths rendered from params (`{{dir}}/{{name}}/README.md` with `name = ../../x`, or with an empty `dir` that renders an absolute path);
- every file written through the `ctx.files` API of a `recipe.ts` (see "The `recipe.ts` contract");
- rollback: `compensateRecipe` validates every path in the compensation it is given (a receipt may come from anywhere) and refuses the whole undo if one of them leaves the root.

Rollback also removes the directories a run created. `compensation.createdDirs` lists them parents first; undoing a run deletes the created files, restores the overwritten ones, then removes those directories deepest first once they are empty (a directory something else has since put a file in is left alone).

Containment covers what the engine writes. A `recipe.ts` is code you chose to install and can still call `node:fs` directly; Baka cannot confine that, which is why pins (`baka.lock.json`) exist and why side-effect recipes should write through `ctx.files`. Constrain string params with `format` or `pattern` (see "Param types") so a bad value is rejected as `invalid-params` before containment is even reached.

## Slot records and replay

Every slot a run fills comes back as data in `slots`, whichever way it was filled:

```jsonc
{ "id": "blurb", "key": "<sha256 hex>", "model": "gemma4:e4b", "value": "...", "source": "llm" }
```

- `id` is the slot id; `value` is the filled value (a string, a list of strings, or a JSON object, per the slot `kind`).
- `key` is the model-independent identity of the fill: sha256 over the template's bytes, the slot id, and the canonical (sorted-key) JSON of the recipe params. Change the template or the params and the key changes.
- `match` is optional and says what `key` covers: `params` (the default; every key a run reports) or `template` (see "Shipping default slot fills" below).
- `model` is the model that produced the value (`manual` for a fill pinned with `baka fill`).
- `source` is `llm` (the model was called this run), `cache` (read from the slot cache), or `replay` (taken from a supplied record).

The caller chooses how slots are obtained with `slots: { mode, records? }` (`--slot-mode` and `--slot-records` on the CLI):

| mode | Behaviour |
|---|---|
| `live` (default) | The slot cache first, then the model. Fresh fills are written to the cache. |
| `record` | Always ask the model; the cache is not read. Fresh fills are written to the cache. Use it to capture a new authoritative set (this replaces the old `--refill`). |
| `replay` | Use only `records`. The cache is neither read nor written and the model is never called, even if a provider was supplied. |

In `replay`, a slot with no record fails the run with `slot-record-missing`. A record whose `key` no longer matches (the template or the params changed since it was taken) fails with `slot-record-stale`, and one whose value does not fit the slot's schema fails with `slot-fill-invalid`. All three are hard errors: nothing is written. Replaying a stored receipt's `slots` therefore reproduces the same bytes and the same `outputTreeHash`, on any machine, with no model:

```bash
baka run hello/greet --name Ada --json > receipt.json
baka run hello/greet --name Ada --json --slot-records receipt.json   # same outputTreeHash, no model call
```

`baka fill` (and `POST /v1/fill`, the `baka_fill` tool) keys its cache entry by the params exactly as a run does: the declared defaults applied and flags such as `--level 2` coerced to the declared type, with the same `invalid-params` refusal. A fill made with the params you typed is therefore replayed by a run with those same typed params, however many defaulted params the recipe declares.

### Shipping default slot fills

A record keyed by params fits one set of params, so a catalog cannot ship it as a default for projects it has never seen. A record with `"match": "template"` is keyed by the template's bytes and the slot id only, and fills that slot for any params. Its `key` is the `templateKey` that `baka slots <pack>/<recipe> --json` (and `baka inspect`) report for the slot, so editing the template makes the record `slot-record-stale` instead of silently applying an old default:

```json
[
	{ "id": "blurb", "key": "<templateKey from baka slots>", "match": "template", "model": "manual", "value": "A default.", "source": "replay" }
]
```

```bash
baka run hello/greet --name Ada --slot-records packs/hello/fixtures/greet.slots.json
```

When a replay holds both kinds for a slot, the record taken against exactly these params wins; a template-matched record is the fallback. Template-matched records are used by `replay` only (the on-disk cache stays params-keyed).

The on-disk cache (`<project>/.baka/slots/<key>.json`, falling back to `$BAKA_HOME/slots` for the CLI and engine) stays the default store behind `live` and `record`. Its key still includes the model (`templateHash + slotId + paramsHash + model`), so two models never share a cached fill. Library callers can inject any `SlotStore`; `createMemorySlotStore()` keeps fills off the disk entirely.

## Param types and the catalog's JSON Schema

A recipe's `params` in the manifest is a list of declarations. Each has a `name`, a `description`, a `required` flag, and a `type`:

| `type` | Extra fields |
|---|---|
| `string`, `number`, `boolean` | none |
| `enum` | `enumValues`: the allowed strings (non-empty) |
| `array` | `items`: the element's type declaration (`{ type, ... }`, recursively) |
| `object` | `properties`: a list of param declarations, the object's fields |

A `string` declaration may constrain its value, and the constraints are enforced with the rest of param validation (an `invalid-params` failure naming the param, before any file is planned or written):

| Field | Meaning |
|---|---|
| `pattern` | A regular expression the value must match. Unanchored, as in JSON Schema: write `^...$` to match the whole value. |
| `minLength`, `maxLength` | Bounds on the length in UTF-16 code units. |
| `format` | A named, anchored pattern: `slug` (`my-app`), `path-segment` (one safe path component: no `/`, backslash, control character, `.` or `..`), `relative-path` (a POSIX path with no leading `/`, no `..` segment, no backslash), `identifier` (`[A-Za-z_$][A-Za-z0-9_$]*`), `package-name` (npm name, optionally scoped). |

They may also sit on `items` (array elements) and on object `properties`. The manifest schema rejects them on any other type, an invalid `pattern`, `minLength` greater than `maxLength`, and a `default` that does not satisfy them. In the JSON Schema below, `pattern`, `minLength`, and `maxLength` are exported as the standard keywords, and a `format` is exported as its expanded `pattern` plus `"x-baka-format": "<name>"`. Constrain every param that ends up in a path: `{ name: "name", type: "string", required: true, description: "...", format: "slug" }`.

Any declaration may carry a `default` (a JSON value of that type). A param with a default is optional, so it must not also be `required`. The manifest schema rejects a declaration whose extra fields do not fit its type (an `enum` without values, a `default` of the wrong type, `enumValues` on a string, and so on), so a bad manifest is caught by `baka pack validate` and by discovery, not at run time.

```ts
params: [
  { name: "title", type: "string", required: true, description: "Page title." },
  { name: "level", type: "number", required: false, description: "Heading level.", default: 1 },
  { name: "tags", type: "array", required: false, description: "Labels.", items: { type: "string" } },
  {
    name: "owner", type: "object", required: false, description: "Who owns it.",
    properties: [{ name: "login", type: "string", required: true, description: "Handle." }],
  },
]
```

`runRecipe` validates the params it is given against these declarations before it does anything else: declared defaults are applied, numeric and `true`/`false` text (CLI flags, form fields) is coerced to the declared scalar type, and anything else is rejected with an `invalid-params` diagnostic that names each offending path. Undeclared params are rejected too, since a typo would otherwise silently change nothing. The params the recipe sees (and that the slot-key hash covers) are the normalized ones, so spelling out a default gives the same run as omitting it.

### JSON Schema

`baka list-packs --json`, `GET /v1/packs`, the `baka://packs` MCP resource, and `describePacks()` from `@baka/core` all return one catalog document:

```jsonc
{
  "packs": [{
    "name": "hello", "version": "0.1.0", "description": "...",
    "recipes": [{
      "id": "greet", "description": "...", "requiresReasoning": false, "filePatterns": [],
      "params": [ /* the declarations above */ ],
      "paramsSchema": { /* JSON Schema draft-07 of the params */ }
    }]
  }],
  "resultSchema": { /* JSON Schema draft-07 of the RecipeResult receipt */ },
  "diagnostics": []
}
```

Both schemas are generated from the Zod schemas the engine itself validates with, never written by hand. `paramsSchema` is a closed object (`additionalProperties: false`) whose `required` lists the required params and whose properties carry each description, enum, element type, nested fields, and default. `resultSchema` describes the receipt in "Running a recipe: the receipt".

## Pinning packs and `baka.lock.json`

Every receipt carries `pins`: the pack the run used, as resolved from disk.

```jsonc
"pins": [{ "id": "hello", "version": "0.1.0", "contentHash": "<sha256 hex>" }]
```

`id` and `version` come from the manifest. `contentHash` is the sha256 (lowercase hex) of this UTF-8 text:

```
baka.pack.v1\n
<path>\0<sha256 of the file's bytes>\n       one line per file
```

over every file under the pack directory, with paths relative to the pack root and POSIX-separated, sorted ascending by the UTF-8 bytes of `<path>`. Symlinks count as their target text and are not followed. These are skipped because they are install or tool residue, not the pack: `node_modules/`, `.git/`, and `out/` directories, `.DS_Store`, and `.design-state.json`. So the hash is the same wherever a pack lives, and changes if and only if a file the pack ships changes. The catalog (`baka list-packs --json`, `describePacks()`) lists each pack's `contentHash`.

### The lockfile

`baka.lock.json` sits at the project root and records the pins a project insists on:

```json
{
	"lockfileVersion": 1,
	"packs": {
		"hello": { "version": "0.1.0", "contentHash": "<sha256 hex>" }
	}
}
```

- `baka lock [pack...]` writes it from the packs currently on disk (every discovered pack, or just the ones named). Commit the file.
- When `<project>/baka.lock.json` exists, `baka run`, the `baka_run` MCP tool, and `POST /v1/run` verify the pack they are about to use against it **before** any slot fill or write. A pack the lock does not list fails with `lock-unlisted`; a different version or different files fail with `lock-mismatch`. Nothing is written and no model is called.
- `runRecipe({ lock })` in `@baka/core` does the same with a lock you pass in (`readLockfile(root)` loads and validates one; `createLock(registry)` builds one). The library never goes looking for a lockfile on its own.

A project with no `baka.lock.json` runs unlocked; the receipt's `pins` still say exactly what ran.

## Rerunning a recipe

Running a recipe again over a tree that already contains its output is normal (a retried job, a second pass after an edit), so what a rerun does is defined, per run, by `onExisting` (`--on-existing`, `onExisting`; default `skip`). It decides what happens to each **template target that already exists**:

| `onExisting` | Existing file has the bytes the template renders | Existing file has other bytes |
|---|---|---|
| `skip` (default) | left alone, reported `unchanged` (`reason: "identical"`) | left alone, reported `skip` (`reason: "already-exists"`), `contentHash` is the file on disk |
| `overwrite` | left alone, reported `unchanged` | rewritten, reported `update`; its previous bytes go into `compensation.overwritten` so the run can be undone |
| `fail` | the run fails with `target-exists` | the run fails with `target-exists` |

`fail` is decided before any slot is filled and before any file is written (so it never costs a model call), and its message lists every existing target. Two further cases fail the same way under every policy, also before any model call: a target path that exists and is not a regular file, and two templates that render to the same path (`template-invalid`).

The changeset is how a caller tells the outcomes apart:

- A rerun over its own output reports every file `unchanged` and returns the same `outputTreeHash` as the run that created them: **same tree**, nothing to do.
- A rerun that reports any `skip` did **not** produce the tree the templates describe: those files hold other bytes, and `outputTreeHash` (which covers the bytes on disk) differs from a fresh run's. Re-run with `overwrite` to converge, or `fail` to refuse up front.
- `overwrite` over a tree that differs reports `update` entries and converges on the same `outputTreeHash` as a fresh run.

Slot fills are independent of this: under the default `live` mode a rerun reads the cache, so it costs no model call and renders the same bytes; see "Slot records and replay".

`onExisting` governs template targets and the files a `recipe.ts` writes through `ctx.files` (it is `ctx.onExisting` there, and the default of `ctx.files.write`), with the same table and the same `unchanged` / `skip` / `update` reporting. A recipe that writes files by other means decides for itself how to treat what is already there; whatever it changes is still reported in the changeset (found by diffing the tree around its `execute`).
