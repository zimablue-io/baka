# Authoring Baka Modules

A **module** is a self-contained directory that exposes typed, validated actions to the baka engine. Modules can live in three places:

| Scope | Where it lives | Discovered by | Wins on dedup? |
|---|---|---|---|
| **in-tree** | `<project>/modules/<name>/` | the engine always | no (lowest priority) |
| **project marketplace** | `<project>/.baka/modules/<name>/` | when listed in `<project>/.baka/settings.json` | yes (overrides in-tree) |
| **user marketplace** | `~/.local/share/baka/modules/<name>/` | when listed in `~/.config/baka/settings.json` | no (loses to project) |

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

1. `baka module init <name>` to scaffold a new module under `modules/`
2. Implement `manifest.ts`, the action.ts files, and the validators
3. `baka module test <name>` to run the action in a scratch dir
4. `baka module validate <name>` to schema-check the manifest
5. Push the repo to a public Git host
6. Users install it with `baka install git:github.com/you/<name>`
