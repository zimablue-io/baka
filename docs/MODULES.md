# Authoring Baka Modules

A **module** is a self-contained directory that exposes typed, validated actions to the baka engine. Modules can live in four places:

| Scope | Where it lives | Precedence on dedup |
|---|---|---|
| **project marketplace** | `<project>/.baka/modules/<name>/` | 1 (highest; wins) |
| **in-tree** | `<project>/modules/<name>/` | 2 |
| **user marketplace** | `${BAKA_HOME:-$HOME/.baka}/modules/<name>/` | 3 |
| **bundled** | the modules shipped inside the baka install itself (`baka-base`, `sdd`, `ts-style`) | 4 (lowest) |

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
  _shared/
    helpers/<name>.ts  # ordinary TS modules, imported via relative paths
    validators/<id>.ts # module-level validators (whole-module checks)
```

The engine enforces the layout. Missing files produce a `manifest-shape` or `action-missing` diagnostic.

The module must be **self-contained**: run its package manager inside the module directory so `baka-sdk` resolves from the module's own `node_modules/`. `baka module test` copies the module (including its `node_modules`) into a temp dir and runs the action from that copy, so a module that only resolves `baka-sdk` from a parent workspace fails at run time even if it validates.

## Public boundary: `baka-sdk`

Modules must import only from `baka-sdk` (not from `@repo/protocol` or the engine internals). This makes them portable: when installed in a user's project, the same import resolves to a real `node_modules` entry that the `baka` CLI ships.

```ts
// modules/<my-module>/<action>/action.ts
import { AgentRole, type StepResponse, type WorkflowStep } from "baka-sdk"
```

`baka-sdk` re-exports the public types and runtime helpers you need (`WorkflowStep`, `StepResponse`, `AgentRole`, `OrchestrationState`, `ModuleManifest`, `ModuleManifestSchema`, `ValidationDiagnostic`, `callLLMAsValidator`, ...). If you need something that isn't there, it almost certainly shouldn't be in a module - it should be in the engine.

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

An action is a `WorkflowStep` object: `execute` writes files directly (plain `node:fs`, into `state.targetDirectory`) and returns a `StepResponse`; `compensate` undoes whatever `execute` did if a later step in the plan fails.

The loader resolves the action by export name, in this order: `camelCase(id)`, `camelCase(id)` + `Action`, the exact id, id + `Action`, then the default export. For the id `say-hello`, the export `sayHello` or `sayHelloAction` resolves; the example uses `sayHelloAction`.

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AgentRole, type StepResponse, type WorkflowStep } from "baka-sdk"

interface SayHelloInput {
	name: string
}

interface SayHelloCompensation {
	createdFiles: string[]
}

export const sayHelloAction: WorkflowStep<SayHelloInput, boolean, SayHelloCompensation> = {
	name: "hello-mod.say-hello",
	role: AgentRole.WORKER,

	execute: async (input, state): Promise<StepResponse<boolean, SayHelloCompensation>> => {
		const file = join(state.targetDirectory, "hello.txt")
		try {
			mkdirSync(state.targetDirectory, { recursive: true })
			writeFileSync(file, `hello ${input.name}\n`, "utf-8")
			return { success: true, output: true, compensationData: { createdFiles: [file] } }
		} catch (err) {
			return {
				success: false,
				output: false,
				compensationData: { createdFiles: [] },
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},

	compensate: async (data): Promise<void> => {
		for (const file of data.createdFiles) {
			try {
				rmSync(file, { force: true })
			} catch {
				// best effort
			}
		}
	},
}
```

## Validators

A module can declare two kinds of validators. Both are plain async functions that return `ValidationDiagnostic[]` (an empty array means pass). The manifest references the validator by its camelCase id; the file on disk is the kebab-case form (`hasGreeting` -> `has-greeting.ts`) and must export a function named with the camelCase id.

### Module-level (`_shared/validators/<kebab-id>.ts`)

Run once per validate pass. Inspect any file in the project. Use for cross-cutting rules ("no `console.log` in production code").

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

Run only when the action ran. Receives the action's `compensationData` as its second argument, so you can check what the action produced:

```ts
// manifest.ts → actions: [{ id: "say-hello", validators: ["hasGreeting"], ... }]
// say-hello/validators/has-greeting.ts
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrchestrationState, ValidationDiagnostic } from "baka-sdk"

export async function hasGreeting(state: OrchestrationState, actionData: unknown): Promise<ValidationDiagnostic[]> {
	const created = (actionData as { createdFiles?: string[] } | null | undefined)?.createdFiles ?? []
	const file = created.find((f) => f.endsWith("hello.txt")) ?? join(state.targetDirectory, "hello.txt")
	if (!existsSync(file)) {
		return [{ severity: "error", rule: "has-greeting", message: `say-hello produced no hello.txt at ${file}` }]
	}
	if (!readFileSync(file, "utf-8").startsWith("hello ")) {
		return [{ severity: "error", rule: "has-greeting", message: `${file} does not contain a greeting` }]
	}
	return []
}
```

A validator that needs to judge semantic content (is this spec coherent?) can ask the validator-role LLM via `callLLMAsValidator` from `baka-sdk`; keep deterministic checks as plain TypeScript.

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
baka validate                     # run all module-level validators
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
