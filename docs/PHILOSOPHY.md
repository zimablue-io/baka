# Baka — Philosophy

> 馬鹿 (baka): "stupid" in Japanese. In this project, stupidity is the feature.

## The core goal

**Baka exists to make LLMs *stupid on purpose*.**

Modern LLM-assisted development suffers from a specific failure mode: the model is asked to invent code, files, and structure from scratch, every time, on every project. The result is a thousand subtly different ways to write the same auth handler, the same error boundary, the same TypeScript module. The model re-invents the wheel constantly, and no two invocations produce the same tree.

Baka fixes this by stripping the LLM of the ability to invent anything. The model is constrained to pick from a finite, declared action space — the catalog of actions in the user's installed modules. The same intent + the same modules always produce the same plan. The wheel stops being re-invented.

## The invariant

> The LLM cannot invent code, files, or structure. It picks from a finite, declared action space.

This invariant is enforced by architecture, not by prompting:

1. **The Orchestrator** receives the user intent and the full module manifest catalog. It may only emit `{module, action, params}` steps that reference declared module/action ids. Plans are validated against a Zod schema; an action that does not exist in the catalog is a hard error.
2. **The Worker** dispatches one declared action to a deterministic TypeScript handler in the module. When the action's manifest sets `requiresReasoning: true`, the worker uses a small LLM assist with a prompt built from the action's versioned `templates/*.hbs` — but the assist only fills fields the module's template declares. The module's structure is not negotiable.
3. **The Validator** is deterministic TypeScript. It runs the module's `validators/*.ts` and `_shared/validators/*.ts` functions against the resulting file tree. No LLM is involved.

If any tier is tempted to invent, the tier boundary refuses to cooperate. The Validator would flag the result. The Worker would reject a non-declared action. The Orchestrator's schema would reject a non-catalog reference.

## The tier rules

### Orchestrator (LLM, high reasoning)
- **Input:** user intent + the full module manifest catalog
- **Output:** `ResolvedPlan` (array of `{module, action, params}`), validated against a Zod schema
- **Authority:** the catalog. Anything not in the catalog is a hard error.
- **Compensation:** none (read-only role)

### Worker (dumb automation by default, with optional small-LLM assist)
- **Input:** one `{module, action, params}` step
- **Default mode:** load `modules/<name>/<action.id>/action.ts`, run it, get a `StepResponse`. No LLM.
- **Reasoning mode** (when `requiresReasoning: true`): render `templates/*.hbs` with the action's params, call the configured provider with a Zod-constrained schema for the body, write the body into the file the template declares. The LLM only fills the body; the file's path, exports, and surrounding code are dictated by the template.
- **Compensation:** calls the action referenced in `compensatesWith` (the inverse action), with bounded retries (3 attempts, exponential backoff).

### Validator (deterministic TypeScript)
- **Input:** the post-execution file tree + the module's `filePatterns` and `moduleValidators`
- **Output:** `Pass` or `Fail(diff[])` with structured diagnostics (`{severity, rule, message, file, hint}`)
- **No LLM in the hot path.** The LLM is only used to *generate* the validator function during module authoring; the function itself is pure TS.
- **Compensation:** none (read-only role)

## The provider boundary

All provider knowledge is sealed inside `packages/agent-engine/`. Nothing else in the codebase may import a provider, an HTTP client, or know the user's model name. The boundary is enforced by:

1. `packages/protocol` defines the `LLMProvider` interface (pure types).
2. `packages/agent-engine` owns the `createLLMProvider(config)` factory and all concrete implementations (e.g. `OpenAICompatibleProvider`).
3. Workflows, `ast-tooling`, and the CLI import only the interface.

**The grep test:** `grep -rE "fetch\(|https?://|api\.openai|anthropic" packages/ workflows/ apps/ --include="*.ts" | grep -v "agent-engine/"` must return zero matches. If it doesn't, the boundary is leaking and Phase 1's invariant is broken.

## Config is user-driven, not file-driven

Users configure the engine via the CLI:

```bash
baka init            # interactive first-time setup
baka config list     # view all keys (secrets masked)
baka config get <k>  # get a value
baka config set <k> <v>
baka config unset <k>
baka providers add <name>   # register a named provider
baka providers use <name>   # switch active provider
```

The CLI stores the config at `$XDG_CONFIG_HOME/baka/config.json` (with platform-correct fallbacks) and secrets at `$XDG_CONFIG_HOME/baka/credentials` with `0600` perms. Env vars (`BAKA_LLM_*`) override for CI. The user never hand-edits a config file.

**Precedence (highest first):** CLI flag > env var > per-project local override (`.baka/local.json`) > user config > built-in defaults.

## Module authoring is action-centric

```
modules/<name>/
|-- manifest.ts              # CONTRACT
|-- <action-id>/
|   |-- action.ts            # dumb or LLM-assisted
|   |-- templates/           # Handlebars (only if requiresReasoning)
|   `-- validators/          # action-specific checks
`-- _shared/                 # optional cross-cutting
    |-- templates/
    |-- validators/
    `-- helpers/
```

Adding or removing an action is one directory operation. Each action is a self-contained unit. The manifest is the source of truth; everything else is referenced by the manifest. The CLI drives authoring (`baka module init/validate/test/list-actions/edit`); users do not hand-write manifests.

## Why "baka"

The point of this project is to make LLMs *stupid on purpose*. The same auth, the same error handling, the same TypeScript style, every time, on every project, on whatever model the user plugs in. The LLM is the orchestrator, not the author. 馬鹿.

## Process rule

Ship what's needed for the current task. Do not architect for a future replacement that may never come. When a new requirement actually lands, design and build it then. No v0 stubs, no "for now" abstractions, no parallel implementations waiting to be merged.
