# Baka — Philosophy

> 馬鹿 (baka): "stupid" in Japanese. In this project, stupidity is the feature.

## The core goal

**Baka exists to make LLMs *stupid on purpose*.**

Modern LLM-assisted development suffers from a specific failure mode: the model is asked to invent code, files, and structure from scratch, every time, on every project. The result is a thousand subtly different ways to write the same auth handler, the same error boundary, the same TypeScript module. The model re-invents the wheel constantly, and no two invocations produce the same tree.

Baka fixes this by stripping the LLM of the ability to invent anything. Files are templates with named slots. Params interpolate. The same command + the same params + the same slot cache always produce the same tree. The planner is a fuzzy catalog picker, not the product. The wheel stops being re-invented.

## The invariant

> The LLM cannot invent code, files, or structure. It picks from a finite, declared action space.

This invariant is enforced by architecture, not by prompting:

1. **The Orchestrator** receives the user intent and the full module manifest catalog. It may only emit `{module, action, params}` steps that reference declared module/action ids. Plans are validated against a Zod schema; an action that does not exist in the catalog is a hard error.
2. **The Worker** materializes `templates/` to disk. Params interpolate. Named `{{#slot}}` holes are the only LLM surface (constrained JSON, temperature 0, cached). `action.ts` is optional side effects. `gemma4:e4b` is the intelligence floor.
3. **The Validator** is deterministic TypeScript. It runs the module's `validators/*.ts` and `_shared/validators/*.ts` functions against the resulting file tree. No LLM is involved.

If any tier is tempted to invent, the tier boundary refuses to cooperate. The Validator would flag the result. The Worker would reject a non-declared action. The Orchestrator's schema would reject a non-catalog reference.

## The tier rules

### Orchestrator (LLM, high reasoning)
- **Input:** user intent + the full module manifest catalog
- **Output:** `ResolvedPlan` (array of `{module, action, params}`), validated against a Zod schema
- **Authority:** the catalog. Anything not in the catalog is a hard error.
- **Compensation:** none (read-only role)

### Worker (calls the worker-role model directly, no LLM assist on top)
- **Input:** one `{module, action, params}` step
- **Default mode:** materialize `templates/` (params + named slots). Load `action.ts` only when it exists (side effects).
- **Slots** (when a template has `{{#slot}}`): one constrained JSON call per empty slot at temperature 0. Cache key = templateHash + slotId + paramsHash + model. `--refill` is explicit.
- **Forbidden:** whole-file `{ content: string }` generation. The model never authors headings, paths, or file lists.
- **Compensation:** calls the action referenced in `compensatesWith` (the inverse action), with bounded retries (3 attempts, exponential backoff).

### Validator (deterministic TypeScript by default, validator-role LLM available per module)
- **Input:** the post-execution file tree + the module's `filePatterns` and `moduleValidators`
- **Output:** `Pass` or `Fail(diff[])` with structured diagnostics (`{severity, rule, message, file, hint}`)
- **Default mode:** deterministic TypeScript. Every structural check (file existence, placeholder detection, heading presence) runs without the LLM.
- **Optional validator-role LLM:** a validator MAY call `baka-sdk.callLLMAsValidator(...)` to ask the validator-role model for a semantic review (e.g. "is this spec coherent?"). The structural checks still run first; the LLM call is for additional context. Hard-fail if the validator role is not configured; absorb transient LLM errors as warnings.
- **Compensation:** none (read-only role)

## The provider boundary

All provider knowledge is sealed inside `packages/agent-engine/`. Nothing else in the codebase may import a provider, an HTTP client, or know the user's model name. The boundary is enforced by:

1. `packages/protocol` defines the `LLMProvider` interface (pure types).
2. `packages/agent-engine` owns the `createLLMProvider(config)` factory and all concrete implementations (e.g. `OpenAICompatibleProvider`).
3. Workflows, `ast-tooling`, and the CLI import only the interface.

**The grep test:**

```bash
grep -rE "api\.openai|api\.anthropic|@anthropic-ai/sdk|@earendil-works/pi-coding-agent|from \"openai\"|from 'openai'" packages/ workflows/ apps/ --include="*.ts" --exclude="*.test.ts" | grep -v "agent-engine/"
```

must return zero matches. If it doesn't, the boundary is leaking and the provider-sealing invariant is broken. The pattern targets LLM provider SDKs and provider API hosts specifically: non-test source may legitimately contain other URLs (marketplace catalog config, fixture hosts), which are not boundary leaks. Test files may reference provider names when they assert the boundary itself.

## Config is role-keyed

Users configure two roles in `${BAKA_HOME:-$HOME/.baka}/config.json` via the CLI. Every LLM call picks one role's model: the **worker** role drives plan / apply / module-design; the **validator** role drives module validators that need a semantic review. Each role is its own choice — a small validator model and a large planner model are both fine.

```bash
baka init                              # interactive first-time setup (writes both roles)
baka roles                             # view every role's fields (apiKey masked as <set>)
baka role worker --field model --value gemma4:e4b     # mutate one field non-interactively
baka role validator --field baseUrl --value http://localhost:8080/v1
```

The CLI stores the role-keyed config at `${BAKA_HOME:-$HOME/.baka}/config.json`. apiKey lives inline in each role's block; there is no separate credentials file. The user can edit any field via `baka role <name> --field <k> --value <v>`, or hand-edit the JSON file directly (the file is plain JSON, no perms ceremony).

**Precedence (highest first):** `loadLLMConfig` overrides > role block in `${BAKA_HOME:-$HOME/.baka}/config.json` > built-in defaults. Defaults apply to optional fields only: `baseUrl`, `model`, and `apiKey` are required and a block missing any of them fails fast at load, naming the role and the exact missing field.

If a role is not configured, the corresponding call hard-fails with `missing LLM config: <role> role not configured` and `code: BAKA_CONFIG_MISSING`. There is no fall-back; there is no alias.

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

Adding or removing an action is one directory operation. Each action is a self-contained unit. The manifest is the source of truth; everything else is referenced by the manifest. The CLI drives authoring (`baka module create/validate/test/list-actions`); users do not hand-write manifests.

## Why "baka"

The point of this project is to make LLMs *stupid on purpose*. The same auth, the same error handling, the same TypeScript style, every time, on every project, on whatever model the user plugs in. The LLM is the orchestrator, not the author. 馬鹿.

## Process rule

Ship what's needed for the current task. Do not architect for a future replacement that may never come. When a new requirement actually lands, design and build it then. No v0 stubs, no "for now" abstractions, no parallel implementations waiting to be merged.
