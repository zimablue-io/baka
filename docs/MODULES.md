# Authoring Baka Modules

A **module** is a self-contained directory that exposes typed, validated actions to the baka engine. Modules can live in three places:

| Scope | Where it lives | Discovered by | Wins on dedup? |
|---|---|---|---|
| **in-tree** | `<project>/modules/<name>/` | the engine always | no (lowest priority) |
| **project marketplace** | `<project>/.baka/modules/<name>/` | when listed in `<project>/.baka/settings.json` | yes (overrides in-tree) |
| **user marketplace** | `~/.baka/modules/<name>/` | when listed in `~/.baka/settings.json` | no (loses to project) |

Install a module into the project marketplace with `baka install <source>`. Sources can be `npm:@scope/pkg[@ver]`, `git:host/repo[@ref]`, `https://...`, `/abs/path`, or `./rel/path`.

## Layout

```
modules/<my-module>/
  package.json         # self-contained; depends on baka-sdk, peer-deps on baka
  tsconfig.json        # extends base.json; maps "baka-sdk" to a real path
  manifest.ts          # exports `Manifest` (typed via ModuleManifestSchema)
  scaffold/
    action.ts          # the action implementation
    templates/         # required if requiresReasoning: true
    validators/<id>.ts # one file per rule declared in manifest
  add-script/
    action.ts
  _shared/
    helpers/<name>.ts  # reusable helpers, loaded by `loadSharedHelper`
    templates/         # shared handlebars templates
    validators/<id>.ts # module-level validators (whole-module checks)
```

The engine enforces the layout. Missing files produce a `manifest-shape` or `action-missing` diagnostic.

## Public boundary: `baka-sdk`

Modules must import only from `baka-sdk` (not from `@repo/protocol`). This makes them portable: when installed in a user's project, the same import resolves to a real `node_modules` entry that the `baka` CLI ships.

```ts
// modules/<my-module>/<action>/action.ts
import { type OrchestrationState, type ActionFn } from "baka-sdk"
```

`baka-sdk` re-exports the public types and runtime helpers you need (`OrchestrationState`, `ActionFn`, `ModuleManifest`, `bakaProjectPaths`, `bakaUserDir`, `readIfExists`, ...). If you need something that isn't there, it almost certainly shouldn't be in a module - it should be in the engine.

## Action signatures

```ts
import { type ActionFn, type WorkerRollbackData } from "baka-sdk"

export const action: ActionFn = async (input, state) => {
  // input.parameters: whatever the LLM supplied (validated by your schema)
  // state.targetDirectory: where the work happens
  // Return a list of file ops for the apply phase to materialize.
  return {
    compensationData: { createdFiles: ["src/index.ts"] },
    ops: [{ kind: "writeFile", path: "src/index.ts", contents: "..." }],
  }
}

export const compensation: (data: WorkerRollbackData) => Promise<void> = async (data) => {
  // SAGA calls this if a later step fails.
}
```

## Validators

A module can declare two kinds of validators:

### Module-level (`_shared/validators/<id>.ts`)

Run once per validate pass. Inspect any file in the project. Use for cross-cutting rules ("no `console.log` in production code").

```ts
// manifest.ts
export const Manifest = {
  moduleValidators: ["noConsoleLog"],
  ...
}
```

### Action-level (`<action>/validators/<id>.ts`)

Run only when the action ran. Receive the action's `compensationData`, so you can check what the action produced:

```ts
// manifest.ts → actions: [{ id: "scaffold", validators: ["hasConsoleLog"], ... }]
```

```ts
// scaffold/validators/hasConsoleLog.ts
import { type ActionValidatorFn, readIfExists, bakaProjectPaths } from "baka-sdk"

export const validator: ActionValidatorFn = async (state, actionData) => {
  const created = actionData?.compensationData?.createdFiles as string[] | undefined
  if (!created) return []
  const findings = []
  for (const f of created) {
    const path = `${state.targetDirectory}/${f}`
    const body = readIfExists(path)
    if (body && !body.includes("console.log")) {
      findings.push({
        severity: "warning",
        rule: "scaffold:hasConsoleLog",
        message: `${f} should include console.log for a hello-world example`,
      })
    }
  }
  return findings
}
```

## Shared helpers

A helper is just a function in `_shared/helpers/<name>.ts`. Load it with `loadSharedHelper` from `@repo/ast-tooling`. Use this for code that several actions share (parsing package.json, walking the dep tree, etc.) without duplicating logic.

## Reasoning actions

If `requiresReasoning: true`, the LLM is shown a prompt that includes the action's `templates/` folder. Drop handlebars templates in there, and the engine will ask the LLM to think through them before producing its plan. Use this for actions where the LLM needs structured guidance ("here's a checklist of things to consider when scaffolding...").

## Listing and validating

```sh
baka list-modules                 # walks all three scopes
baka module validate <name>       # schema + layout check
baka validate                     # run all module-level validators
```

## Lifecycle of a published module

1. `baka module create <name>` to design a new module through the chat-driven double-diamond flow
2. Review the LLM's design, refine via chat, and let the consistency test validate it
3. `baka module test <name>` to run any one action in a scratch dir
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
