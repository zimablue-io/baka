# Authoring Baka Modules

A **module** is a self-contained directory that exposes typed, validated actions to the baka engine. Modules can live in four places:

| Scope | Where it lives | Precedence on dedup |
|---|---|---|
| **project marketplace** | `<project>/.baka/modules/<name>/` | 1 (highest; wins) |
| **in-tree** | `<project>/modules/<name>/` | 2 |
| **user marketplace** | `${BAKA_HOME:-$HOME/.baka}/modules/<name>/` | 3 |
| **bundled** | modules shipped with a baka install, if any | 4 (lowest) |

Discovery walks every scope on every run; there is no registration step, and both real directories and symlinks are accepted. When two scopes provide the same module name, the first scope in precedence order owns it and the lower-precedence copies are skipped. The bundled scope is listed only when the current working directory looks like a project (has a `package.json`), so `baka list-modules` from an unrelated directory does not echo the bundled catalog.

Install a module into the project marketplace with `baka install <source>` (links it under `<project>/.baka/modules/`); add `--user` to install into the user marketplace instead. Sources can be `npm:@scope/pkg[@ver]`, `git:host/repo[@ref]`, `https://...`, `/abs/path`, or `./rel/path`.

## Layout

```
modules/<my-module>/
  package.json         # self-contained; depends on baka-sdk, peer-deps on baka
  tsconfig.json        # extends your TS base; maps "baka-sdk" to a real path
  README.md            # recommended; its absence is a `baka module validate` warning
  manifest.ts          # exports `Manifest` (typed via ModuleManifestSchema)
  scaffold/
    action.ts          # the action implementation
    templates/         # required if requiresReasoning: true
    validators/<id>.ts # one kebab-case file per rule declared in manifest
  add-script/
    action.ts
  data/
    <name>.json        # read-only data, exposed as `data.<name>` (see "Module data")
  _shared/
    helpers/<name>.ts  # ordinary TS modules, imported via relative paths
    validators/<id>.ts # module-level validators (whole-module checks)
```

The engine enforces the layout. `action.ts` may be omitted when `templates/` is the output tree. Missing both produces an `action-missing` diagnostic.

The module must be **self-contained**: `baka module test` copies the module (including its `node_modules`) into a temp dir and runs the action from that copy, so anything the module imports at run time must resolve from inside it. Types from `baka-sdk` are erased and need no install.

## Public boundary: `baka-sdk`

Modules import only from `baka-sdk` (not from `@repo/protocol` or the engine internals), and **only types**. `baka-sdk` is not installed next to a module and the engine does not alias it at run time, so a runtime import (`import { AgentRole } from "baka-sdk"`, a bare `import "baka-sdk"`, `require("baka-sdk")`) fails to load in any catalog without its own `node_modules`. Write `import type { ... } from "baka-sdk"` everywhere: jiti erases it, and the module type-checks against the SDK (or a copy of its `.d.ts`) without Baka being installed. `baka module validate` scans a module's TypeScript files and fails on a runtime import of `baka-sdk` (`sdk-runtime-import`, with the file and line); `import type { A } from "baka-sdk"` and `import { type A } from "baka-sdk"` are both accepted.

An `action.ts` therefore exports an `ActionStep`, which has no `role` (the one runtime value a step used to need, `AgentRole.WORKER`, is gone):

```ts
import type { ActionStep } from "baka-sdk"
```

`baka-sdk` exports the public types you need (`ActionStep`, `ActionContext`, `ActionFiles`, `OrchestrationState`, `ModuleManifest`, `ValidationDiagnostic`, ...). If you need something that isn't there, it almost certainly shouldn't be in a module - it should be in the engine.

## A complete example module

Everything below is copy-pasteable: a module built from these exact files passes `baka module validate` and runs under `baka module test`.

### `modules/hello-mod/manifest.ts`

The manifest must export a `Manifest` value matching `ModuleManifestSchema`. Validator ids are camelCase here; the validator files on disk are the kebab-case form of the same id.

```ts
import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
	name: "hello-mod",
	version: "0.1.0",
	description: "Writes a greeting file into the target project.",
	dependencies: [],
	conflictsWith: [],
	actions: [
		{
			id: "say-hello",
			description: "Write hello.txt containing a greeting.",
			requiresReasoning: false,
			filePatterns: ["hello.txt"],
			validators: ["hasGreeting"],
			params: [{ name: "name", type: "string", required: true, description: "Who to greet." }],
		},
	],
	moduleValidators: [],
}
```

### `modules/hello-mod/say-hello/action.ts`

An action is an `ActionStep` object: `execute` writes files through `ctx.files` (contained to the project, honouring `onExisting`, virtual in a dry run) and returns a `StepResponse`; `compensate` undoes whatever `execute` did by means the engine cannot see (the engine itself undoes `ctx.files` writes, template files, and the directories it created). The full contract is in "The `action.ts` contract" below.

The loader resolves the action by export name, in this order: `camelCase(id)`, `camelCase(id)` + `Action`, the exact id, id + `Action`, then the default export. For the id `say-hello`, the export `sayHello` or `sayHelloAction` resolves; the example uses `sayHelloAction`.

```ts
import type { ActionStep } from "baka-sdk"

interface SayHelloInput {
	name: string
}

export const sayHelloAction: ActionStep<SayHelloInput, string, null> = {
	name: "hello-mod.say-hello",

	execute: async (input, _state, ctx) => {
		const written = ctx.files.write("hello.txt", `hello ${input.name}\n`)
		return { success: true, output: written.op, compensationData: null }
	},

	// Nothing to undo that the engine does not already undo.
	compensate: async () => {},
}
```

## The `action.ts` contract

An action with an `action.ts` runs after its templates (if any) are written. `execute(params, state, ctx)` receives the **normalized params** (defaults applied, constraints checked), an `OrchestrationState` whose `targetDirectory` is the project root, and an `ActionContext`:

| `ctx` field | Meaning |
|---|---|
| `onExisting` | The run's policy (`skip` default, `overwrite`, `fail`). `ctx.files.write` applies it; an action that writes by other means must honour it itself. |
| `dryRun` | True in a dry run (see below). |
| `files` | The contained file API: `exists(path)`, `readText(path)`, `write(path, content, { onExisting? })`, `remove(path)`, `own(...paths)`. |
| `module` | `{ name, version, root }` of the running module (read-only; never write into `root`). |
| `projectRoot` | The project root (same as `state.targetDirectory`). |
| `llmProvider` | The injected provider or null. |

`compensate(data, state, ctx)` gets the same context.

**`ctx.files`.** Paths are project-relative POSIX paths and are contained (see "Path containment"): an escaping path throws, the run fails with `path-escape`, and everything written so far is undone. `write` creates parent directories and answers `{ path, op, contentHash }`:

- the file does not exist: written, `create`;
- it holds exactly these bytes: not touched, `unchanged` (whatever the policy, except `fail`);
- it holds other bytes: `skip` leaves it (`skip`), `overwrite` rewrites it (`update`), `fail` throws `target-exists`.

Every call is journalled, so the engine can undo it, and reported in the changeset judged against what was there when the action first touched the path (so a file written twice is one `create`). `own("path")` declares a file the action produces by other means (a spawned tool, a direct `node:fs` write): if it exists afterwards and did not change it is listed as `unchanged`, which is what keeps a rerun's `outputTreeHash` equal to the first run's for such files.

**What the engine does around `execute`.** It hashes the project tree before and after (skipping `.git/`, `node_modules/`, and the root `.baka/`). Files the action created by any means, and directories it created, are therefore known: they go into `compensation.created` / `createdDirs`, and into the changeset as `create`, `update`, or `delete`. Only `ctx.files` also gives previous bytes (restorable) and `unchanged` entries.

**Failure is compensated by the engine.** If `execute` throws, or returns `success: false`, the engine (1) calls the action's `compensate` with the `compensationData` it returned (not when it threw: there is no data), (2) deletes every file the run created (templates, `ctx.files`, plain `node:fs`), (3) restores every file overwritten through templates or `ctx.files`, (4) removes the directories the run created. Files an action modified behind the API's back cannot be restored (the engine never had their bytes); the receipt then carries a `rollback-incomplete` warning naming them. The failed run's changeset is empty and its single error diagnostic is `action-failed`, or the code of the engine error (`path-escape`, `target-exists`) that `ctx.files` threw.

**Dry run.** `ctx.dryRun` is true when the caller asked for one. An action may only run in a dry run if its manifest action sets `supportsDryRun: true`; otherwise the run fails with `dry-run-unsupported`, exactly as before. A dry-runnable action promises to write only through `ctx.files` (which then act on a virtual tree: reads see the template files the run planned and the action's own earlier writes, the disk is never touched) and to spawn nothing. Baka checks the promise by hashing the tree before and after; an action that changed it anyway fails with `dry-run-violation` (anything it created is removed, anything it modified is named in the message). The receipt of a dry run has the same changeset and `outputTreeHash` a real run on the same tree would produce.

```ts
export const Manifest = {
	// ...
	actions: [{ id: "scaffold", supportsDryRun: true, /* ... */ }],
}
```

**What is not covered.** `action.ts` is code, and plain `node:fs` and `child_process` calls are outside anything Baka can contain. Pins (`baka.lock.json`) say which code ran; `ctx.files` is the way to get containment, `unchanged` reporting, dry runs and automatic rollback.

## Validators

A module can declare two kinds of validators. Both are plain async functions of the `OrchestrationState` that return `ValidationDiagnostic[]` (an empty array means pass). The manifest references the validator by its camelCase id; the file on disk is the kebab-case form (`hasGreeting` -> `has-greeting.ts`) and must export a function named with the camelCase id.

### What a validator receives: `state.run`

`state.targetDirectory` is the project root. `state.run` (a `ValidatorRun`) says which action run the validator is judging:

| `state.run` field | Meaning |
|---|---|
| `module`, `action` | The action. |
| `ran` | True when the action ran in this invocation; false when `baka validate` found its output through a `marker` (below). |
| `params` | The params the action ran with, normalized (defaults applied). Empty when `ran` is false. |
| `compensationData` | What the action's `execute` returned as compensation data; for a template-only action `{ written: [paths] }`. Null when `ran` is false. |
| `output` | What the action's `execute` returned as output; null for template-only actions and when `ran` is false. |
| `changeset` | The run's changeset (`create` / `update` / `unchanged` / `skip` / `delete` entries). Empty when `ran` is false. |
| `detected` | When `ran` is false: the project paths the marker matched. |

`state.run` is undefined for a module-level validator under `baka validate`.

### Which validators run

- **After a run** (`runAction`, `baka run`, the MCP `baka_run` tool, `POST /v1/run`): the module-level validators of the module, and the validators of **the action that ran**, nothing else. A sibling action's validators and other modules are not touched. Module-level validators see the same `state.run` (the action that triggered them). `baka run` validates by default exactly as `runAction` does (`--no-validate`, or `validate: false`, skips it); a dry run never validates.
- **After `baka apply`**: for each completed step, as above (module-level validators once per module, with `state.run` of the last step of that module).
- **`baka validate [-m <module>]`** runs no action. It runs module-level validators (`state.run` undefined), plus an action's validators only for actions whose output it can detect: an action that declares a `marker` in its manifest, a list of glob patterns relative to the project root (`*` within a segment, `**` across segments, `?`), e.g. `marker: ["packages/*/package.json"]`. If any project file matches, the action's validators run once with `state.run.ran === false` and `state.run.detected` listing the matches. An action without a marker has its validators run only after it ran.

Structural problems found at discovery (a missing validator file, a broken manifest) are reported only for the modules in scope: a sibling module's `action-validator-missing` does not fail an unrelated module's run, but does fail `baka validate` over the whole project.

### Diagnostics

Every diagnostic a validator returns is reported in the receipt's `diagnostics`, **warnings included, whether or not validation passes**; `ok` is false only when one is an `error`. Baka does not rewrite the validator's `rule`: it is whatever the validator set (the validator's own id stands in when it set none). Baka adds `validator`, the namespaced id of the validator that produced it: `<module>:<id>` for a module-level validator, `<module>.<action>:<id>` for an action-level one. A validator that throws is reported as an error with `rule: "validator-error"` and its `validator` set.

### Module-level (`_shared/validators/<kebab-id>.ts`)

Run once per validation pass. Inspect any file in the project. Use for cross-cutting rules ("no `console.log` in production code").

```ts
// manifest.ts → moduleValidators: ["hasPackageJson"]
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

### Action-level (`<action>/validators/<kebab-id>.ts`)

Run when the action ran (or, under `baka validate`, when its marker matches). Use `state.run` to check what the action produced:

```ts
// manifest.ts → actions: [{ id: "say-hello", validators: ["hasGreeting"], marker: ["hello.txt"], ... }]
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

Keep validators deterministic TypeScript. `callLLMAsValidator` (the validator-role model) is a runtime export of `baka-sdk`, which a module may not import (see "Public boundary"), so a module in a catalog without installs cannot call it from a validator.

## Shared helpers

A helper is an ordinary TypeScript module under `_shared/helpers/<name>.ts`. Actions import it with a plain relative import:

```ts
import { readJsonSafe } from "../_shared/helpers/read-json-safe"
```

Use this for code that several actions share (parsing package.json, walking the dep tree, etc.) without duplicating logic.

## Reasoning actions

If `requiresReasoning: true`, the LLM is shown a prompt that includes the action's `templates/` folder. Drop handlebars templates in there, and the engine will ask the LLM to think through them before producing its plan. Use this for actions where the LLM needs structured guidance ("here's a checklist of things to consider when scaffolding...").

## Listing and validating

```sh
baka list-modules                 # walks all four scopes
baka module validate <name>       # schema + layout check + loadability gate (every declared action and validator must import through the engine's loader)
baka validate                     # module-level validators, plus action validators whose marker matches
```

## Lifecycle of a published module

1. `baka module create <name>` to design a new module through the chat-driven double-diamond flow
2. Review the LLM's design, refine via chat, and let the consistency test validate it
3. `baka module test <name> --action=<id> --input='<json>'` to run any one action in a scratch dir
4. Push the repo to a public Git host
5. Users install it with `baka install git:github.com/you/<name>`

## Chat-driven module creation (the `baka module create` flow)

The baka CLI includes a chat REPL that drives a full **double-diamond** design process for your module. The LLM proposes; you refine. State is saved after every turn, so you can `/exit` and resume at any time.

```sh
baka module create <name>   # enter the design chat
```

You will be asked for a one-sentence brief of what the module does, then the LLM takes over. The flow has four phases, and the LLM drives transitions via a `phase` field in its response.

### Phases

| Phase | What happens | What the LLM does |
|---|---|---|
| **DISCOVER** | The LLM asks 3-6 clarifying questions per turn about your domain, conventions, and anti-patterns. | Asks; then writes a `PREFERENCES.md` draft when the answers are clear. |
| **DEFINE** | The LLM proposes an action roster (3-10 actions with id, description, rationale). | Proposes; you curate. |
| **DEVELOP** | For each action: param schema, `requiresReasoning`, `compensatesWith`, validators, and (if reasoning) handlebars template outlines. | Designs; you refine. |
| **DELIVER** | The CLI writes the files, runs `baka module validate`, and runs a **5x consistency test** (the same intent, planned and applied five times; all five must produce identical file trees, identical SHA-256 hashes, and identical plan shapes). | Writes the README summary. |

You type free-form replies at the `> ` prompt. The CLI maintains the full chat history and the LLM sees it on every turn. On `/skip` (or when the LLM signals `finished: true`), the phase advances.

### Slash commands

The REPL intercepts any input that starts with `/`. Available commands:

| Command | Effect |
|---|---|
| `/help` | Show all commands |
| `/save` | Save state to `modules/<name>/.design-state.json` (also auto-saved on every turn) |
| `/show prefs` | Render the current `PREFERENCES.md` |
| `/show actions` | Render the action roster |
| `/show <action-id>` | Render the design for one action |
| `/rewind` | Pop the last turn and re-ask the LLM |
| `/back <phase>` | Jump back to `DISCOVER`/`DEFINE`/`DEVELOP`/`DELIVER` |
| `/skip` | Accept the LLM's current proposal and advance the phase |
| `/consistency [n] [intent]` | Run the 5x consistency test now (any phase) |
| `/exit` | Save and quit; resume with `baka module create <name>` |

### Re-running the consistency test on an existing module

```sh
baka module consistency <name> --action=<id> --intent="<test intent>" --n=5
```

Output includes the per-run trace, the divergences (if any), and the path to a `CONSISTENCY-TRACE.json` file with the full SHA-256 manifest.

### PREFERENCES.md and the planning prompt

`PREFERENCES.md` is the user's preferences for this module. The orchestrator reads it on every plan that uses this module, and inlines a "Module-specific preferences" section into the system prompt. This is the mechanism that makes the user's design choices sticky: the LLM that plans future agents' actions will honor the conventions you set here, not invent new ones.

The CLI writes `PREFERENCES.md` with YAML frontmatter:

```yaml
---
module: my-mod
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

You can edit this file directly with `baka module edit <name>` and the next plan that touches this module will use the new content.

### State file

`modules/<name>/.design-state.json` is the chat history + the LLM's last response + the phase + the roster + the designed actions. Auto-saved on every turn. The state file is **gitignored by convention** (add it to your `.gitignore` if you don't want it tracked):

```gitignore
modules/*/.design-state.json
```

### Why a 5x consistency test?

A module's contract is "if the LLM plans action X with these params, the action will produce these files with these contents". If the action's body has a non-deterministic bug (e.g. depends on a non-seeded RNG, or has an off-by-one that the LLM's plan sometimes hides), the plan can succeed but the run can drift across invocations. The 5x consistency test catches that drift at module creation time, so you see the problem while you still have context. If the test fails, the CLI sends you back to DEVELOP with the divergence trace as the LLM's user-message; the LLM uses the trace to refine the action's params or validators.

The arxiv literature on LLM agent reproducibility (Measuring Determinism in LLM Code Generation; How Consistent Are LLM Agents) explicitly calls out repeated-run variance and recommends N≥5 to be statistically meaningful. We use exact hash equality because the orchestrator already runs at temperature 0.0.

## Running an action: the receipt

`baka run <module>/<action> --json`, the `baka_run` MCP tool, `POST /v1/run`, and `runAction` from `@baka/core` all return the same JSON, an `ActionResult`:

```jsonc
{
  "ok": true,
  "module": "hello",
  "action": "greet",
  "params": { "name": "Ada" },  // the params the run used: defaults applied, scalars coerced
  "diagnostics": [],            // error diagnostics, then validator output (warnings included)
  "changeset": [                // one entry per path the action addressed, sorted by path
    { "path": "hello.md", "op": "create", "contentHash": "<sha256 hex>" }
  ],
  "outputTreeHash": "<sha256 hex>",
  "slots": [ /* the slot fills, see "Slot records and replay" */ ],
  "compensation": { "created": ["hello.md"], "createdDirs": [], "overwritten": [], "actionData": { "written": ["hello.md"] } },
  "output": null,               // what a side-effect action.ts returned, else null
  "dryRun": false
}
```

`ok` is false when any diagnostic has `severity: "error"`. A run that fails while executing (a template error, a missing slot, an `action.ts` that reports failure) leaves nothing behind: files it created are removed, files it overwrote are restored, directories it created are removed, the changeset is empty, and the one error diagnostic carries a stable code in `rule` (`module-not-found`, `action-not-found`, `action-empty`, `invalid-params`, `slot-no-provider`, `slot-provider-error`, `slot-record-missing`, `slot-record-stale`, `slot-fill-invalid`, `template-invalid`, `path-escape`, `dry-run-unsupported`, `action-failed`, `unexpected`). A run whose validators fail is different: the files stay, `ok` is false, and `compensation` still describes everything written so the caller can undo it with `compensateAction`.

### Changeset

Each entry is `{ path, op, contentHash, reason?, mode? }` (`mode` only when a template or `ctx.files.write` declared permission bits). `path` is project-relative, POSIX-separated, with no leading `./`. `contentHash` is the sha256 (lowercase hex) of the file's bytes after the run, or `null` for a delete.

| `op` | Meaning |
|---|---|
| `create` | The file did not exist; it was written. |
| `update` | The file existed with other content and was rewritten. |
| `delete` | The file existed before and is gone after (side-effect actions only). |
| `unchanged` | The file already held exactly the bytes the action would write (`reason: "identical"`). |
| `skip` | The file exists with other content and was left alone (`reason: "already-exists"`). |

For template files the entries come straight from the plan, so they are exact. An action with an `action.ts` can do anything, so what it did is the union of the `ctx.files` journal and a diff of the project tree hashed before and after it runs (skipping `.git/`, `node_modules/`, and the root `.baka/`); the result is merged into the template entries (a path the templates already addressed keeps its op, a created file the action then edited is still a `create`, and a file the action found `unchanged` leaves the template's account alone). `includeContent` (`--include-content`, `includeContent: true`) adds each written file's UTF-8 text as `content` on `create`, `update`, and `unchanged` entries.

### outputTreeHash

`outputTreeHash` identifies the tree an action **owns**. The owned set is every file the action addressed, whether it produced it or found it already there unchanged:

- each template target: `create`, `update`, `unchanged` (identical bytes already there), or `skip` (other bytes, left alone: the hash then covers what is on disk);
- each file an `action.ts` wrote or removed through `ctx.files`, with the same four outcomes (a file it removed is `delete`);
- each file it declared with `ctx.files.own(...)` that exists afterwards;
- each file its `execute` created, changed, or deleted by any other means (found by hashing the tree around it).

A rerun over a tree that already holds the action's output therefore lists the same paths with the same content hashes (as `unchanged`), and has **the same `outputTreeHash`** as the first run: the changeset is the owned set, not just the changes. The one gap is a file an `action.ts` writes with plain `node:fs` and does not `own`: it is visible only on the run where it changes.

The hash is the sha256 (lowercase hex) of this UTF-8 text:

```
baka.tree.v1\n
<path>\0<contentHash>\n          one line per changeset entry
<path>\0<contentHash>\0<mode>\n   ... for an entry that declares a mode (see "Conditional files and file modes")
```

- Lines are sorted ascending by the UTF-8 bytes of `<path>` (not by JS string order).
- `<contentHash>` is the entry's `contentHash`, or the literal `deleted` when it is null.
- The `op` and `reason` are not part of the hash. A first run that `create`s two files and a rerun that finds both `unchanged` therefore hash the same, while a rerun that finds one of them `skip`ped with different content hashes differently: the hash covers the bytes on disk, which is the tree you actually have.
- An empty changeset hashes the text `baka.tree.v1\n`.

### Dry run

`dryRun: true` (`baka run --dry-run`) plans and returns the same receipt without writing anything: no project files and no slot-cache entries. The tree it reports is the tree a real run would leave, given the same slot fills. Template-only actions are always dry-runnable. An action with an `action.ts` is dry-runnable if its manifest sets `supportsDryRun` and it writes through `ctx.files` (see "The `action.ts` contract"); any other action fails with `dry-run-unsupported` rather than pretending. Validators inspect the real tree, so a dry run does not run them. Because a dry run does not persist fills, hand its `slots` to the real run (see "Slot records and replay") when the real run must produce the tree the dry run predicted.

## Template language

Every `.hbs` file under `<action>/templates/` is one output file: its path under `templates/`, minus `.hbs`, is the output path (itself a template: `{{dir}}/{{name}}/README.md.hbs`). The language is a deliberately small Handlebars subset, checked on the parsed template and failing closed: anything outside it fails the run with `template-invalid`, naming the construct.

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

### Module data

Files `data/<name>.json` directly under the module root are parsed and exposed read-only as `data.<name>`: `data/versions.json` is `{{data.versions.pnpm}}` in a template (and in `when` and output paths) and `ctx.data.versions.pnpm` in an `action.ts`. The object is deeply frozen. One copy of shared pins therefore lives in the module, not duplicated into `_shared/` with a drift test. Other files and subdirectories of `data/` are ignored; a file that is not valid JSON, or whose name does not match `[A-Za-z0-9][A-Za-z0-9_-]*`, makes the module invalid (`module-invalid`). The files are part of the module's content hash, so the pin in `baka.lock.json` covers them. `data` is a reserved param name. Data is not shown to the slot model (slot fills depend on the params only).

## Path containment

Everything Baka writes, and everything it deletes on rollback, stays inside the project root. A path is checked in two steps, before the first byte of a run is written and again right before each write:

1. **Lexical.** The path must be a non-empty POSIX string without backslashes, NUL or other control characters; it must not be absolute (`/x`, `C:x`); it must contain no `..` segment (even one that would come back inside, like `a/../b`); it must not name the root itself; it must not go through a `.git` directory at any depth or start in the root's `.baka/` (those hold hooks and installed modules, which are code that runs later).
2. **Resolution.** After resolving symbolic links, the deepest existing ancestor of the target must lie inside the root's real path, and the target itself must not be a symbolic link (a write must not land on the file the link points at).

A violation fails the run with `path-escape`, before anything is written, so the changeset is empty and nothing is left to undo. This covers:

- template output paths rendered from params (`{{dir}}/{{name}}/README.md` with `name = ../../x`, or with an empty `dir` that renders an absolute path);
- every file written through the `ctx.files` API of an `action.ts` (see "The `action.ts` contract");
- rollback: `compensateAction` validates every path in the compensation it is given (a receipt may come from anywhere) and refuses the whole undo if one of them leaves the root.

Rollback also removes the directories a run created. `compensation.createdDirs` lists them parents first; undoing a run deletes the created files, restores the overwritten ones, then removes those directories deepest first once they are empty (a directory something else has since put a file in is left alone).

Containment covers what the engine writes. An `action.ts` is code you chose to install and can still call `node:fs` directly; Baka cannot confine that, which is why pins (`baka.lock.json`) exist and why side-effect actions should write through `ctx.files`. Constrain string params with `format` or `pattern` (see "Param types") so a bad value is rejected as `invalid-params` before containment is even reached.

## Slot records and replay

Every slot a run fills comes back as data in `slots`, whichever way it was filled:

```jsonc
{ "id": "blurb", "key": "<sha256 hex>", "model": "gemma4:e4b", "value": "...", "source": "llm" }
```

- `id` is the slot id; `value` is the filled value (a string, a list of strings, or a JSON object, per the slot `kind`).
- `key` is the model-independent identity of the fill: sha256 over the template's bytes, the slot id, and the canonical (sorted-key) JSON of the action params. Change the template or the params and the key changes.
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

The on-disk cache (`<project>/.baka/slots/<key>.json`, falling back to `$BAKA_HOME/slots` for the CLI and engine) stays the default store behind `live` and `record`. Its key still includes the model (`templateHash + slotId + paramsHash + model`), so two models never share a cached fill. Library callers can inject any `SlotStore`; `createMemorySlotStore()` keeps fills off the disk entirely.

## Param types and the catalog's JSON Schema

An action's `params` in the manifest is a list of declarations. Each has a `name`, a `description`, a `required` flag, and a `type`:

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

Any declaration may carry a `default` (a JSON value of that type). A param with a default is optional, so it must not also be `required`. The manifest schema rejects a declaration whose extra fields do not fit its type (an `enum` without values, a `default` of the wrong type, `enumValues` on a string, and so on), so a bad manifest is caught by `baka module validate` and by discovery, not at run time.

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

`runAction` validates the params it is given against these declarations before it does anything else: declared defaults are applied, numeric and `true`/`false` text (CLI flags, form fields) is coerced to the declared scalar type, and anything else is rejected with an `invalid-params` diagnostic that names each offending path. Undeclared params are rejected too, since a typo would otherwise silently change nothing. The params the action sees (and that the slot-key hash covers) are the normalized ones, so spelling out a default gives the same run as omitting it.

### JSON Schema

`baka list-modules --json`, `GET /v1/modules`, the `baka://modules` MCP resource, and `describeModules()` from `@baka/core` all return one catalog document:

```jsonc
{
  "modules": [{
    "name": "hello", "version": "0.1.0", "description": "...",
    "actions": [{
      "id": "greet", "description": "...", "requiresReasoning": false, "filePatterns": [],
      "params": [ /* the declarations above */ ],
      "paramsSchema": { /* JSON Schema draft-07 of the params */ }
    }]
  }],
  "resultSchema": { /* JSON Schema draft-07 of the ActionResult receipt */ },
  "diagnostics": []
}
```

Both schemas are generated from the Zod schemas the engine itself validates with, never written by hand. `paramsSchema` is a closed object (`additionalProperties: false`) whose `required` lists the required params and whose properties carry each description, enum, element type, nested fields, and default. `resultSchema` describes the receipt in "Running an action: the receipt".

## Pinning modules and `baka.lock.json`

Every receipt carries `pins`: the module the run used, as resolved from disk.

```jsonc
"pins": [{ "id": "hello", "version": "0.1.0", "contentHash": "<sha256 hex>" }]
```

`id` and `version` come from the manifest. `contentHash` is the sha256 (lowercase hex) of this UTF-8 text:

```
baka.module.v1\n
<path>\0<sha256 of the file's bytes>\n       one line per file
```

over every file under the module directory, with paths relative to the module root and POSIX-separated, sorted ascending by the UTF-8 bytes of `<path>`. Symlinks count as their target text and are not followed. These are skipped because they are install or tool residue, not the module: `node_modules/`, `.git/`, and `out/` directories, `.DS_Store`, and `.design-state.json`. So the hash is the same wherever a module lives, and changes if and only if a file the module ships changes. The catalog (`baka list-modules --json`, `describeModules()`) lists each module's `contentHash`.

### The lockfile

`baka.lock.json` sits at the project root and records the pins a project insists on:

```json
{
	"lockfileVersion": 1,
	"modules": {
		"hello": { "version": "0.1.0", "contentHash": "<sha256 hex>" }
	}
}
```

- `baka lock [module...]` writes it from the modules currently on disk (every discovered module, or just the ones named). Commit the file.
- When `<project>/baka.lock.json` exists, `baka run`, the `baka_run` MCP tool, and `POST /v1/run` verify the module they are about to use against it **before** any slot fill or write. A module the lock does not list fails with `lock-unlisted`; a different version or different files fail with `lock-mismatch`. Nothing is written and no model is called.
- `runAction({ lock })` in `@baka/core` does the same with a lock you pass in (`readLockfile(root)` loads and validates one; `createLock(registry)` builds one). The library never goes looking for a lockfile on its own.

A project with no `baka.lock.json` runs unlocked; the receipt's `pins` still say exactly what ran.

## Rerunning an action

Running an action again over a tree that already contains its output is normal (a retried job, a second pass after an edit), so what a rerun does is defined, per run, by `onExisting` (`--on-existing`, `onExisting`; default `skip`). It decides what happens to each **template target that already exists**:

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

`onExisting` governs template targets and the files an `action.ts` writes through `ctx.files` (it is `ctx.onExisting` there, and the default of `ctx.files.write`), with the same table and the same `unchanged` / `skip` / `update` reporting. An action that writes files by other means decides for itself how to treat what is already there; whatever it changes is still reported in the changeset (found by diffing the tree around its `execute`).
