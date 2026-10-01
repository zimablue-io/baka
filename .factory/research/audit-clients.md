# Audit: baka CLI (`apps/cli`) and MCP server (`apps/mcp`)

Date: 2026-07-27. Method: read all of `apps/cli/src` and `apps/mcp/src`, then ran both
binaries for real (tsx against source, JSON-RPC over stdio for MCP), then ran both
scoped test suites. No files modified. Repo left clean (`git status --porcelain`
shows only this report's directory).

Environment note: the user's machine has a llama.cpp server on `localhost:8080`
(model id `gemma4-12b-qat`) and a role-keyed config at `~/.baka/config.json`
(worker + validator, `timeoutMs: 120000`). This made live LLM-path probes possible.

---

## 1. apps/cli (package `baka`, bin `baka`)

### Command surface (from `baka --help`, live)

`init`, `role`, `roles`, `module {create,consistency,validate,list-actions,test,edit}`,
`list-modules`, `plan`, `list-plans`, `apply`, `validate`, `install`, `remove`,
`list-packages`, `update`, `marketplace {add,list,remove,update}`, `search`.

### Verified working live (SOLID)

| Command | Proof |
|---|---|
| `list-modules --json` | Discovers 3 in-tree modules (baka-base, sdd, ts-style) at repo root; clean `no-modules` diagnostic in an empty dir. Exit 0 both ways. |
| `module list-actions baka-base` | Prints 3 actions with params. (`module.ts:runModuleListActions`) |
| `module validate baka-base --json` | `{valid: true}`, exit 0. |
| `roles` | Prints both roles, apiKey masked. Exit 0. With empty `$HOME`: `missing LLM config...` exit 1. |
| `marketplace add/list/remove` | Round-tripped a probe URL against `~/.baka/catalogs.json`; restored to `{"catalogs": []}`. Idempotent add confirmed by tests. |
| `install /abs/path` (local) | Symlinks the module into `<cwd>/.baka/modules/` (`package-manager.ts:copyOrLink`), registers in `.baka/settings.json`. Verified in a temp dir. |
| `install npm:zod@3.23.0` | `npm pack` + extract works; package materialized, listed by `list-packages`, removed by `remove`. |
| `remove`, `update`, `list-packages` | All behave in a temp project (update: "no packages to update"). |
| `validate --json` | Exit 4 (VALIDATION_ERROR) with structured diagnostics against the repo root. Runs for real. |
| `module test baka-base -a scaffold` | Runs the action in an isolated temp dir, prints `RESULT: true`, cleans up. |
| `plan` with no LLM config | `baka: missing LLM config: worker role not configured. Run \`baka init\`.` exit 1 (USER_ERROR). Correct contract. |
| `plan` against a dead port (5s timeout) | Fails fast (0.3s), exit 2, JSON `{status:"FAILED", logs:[..."fetch failed"]}`. Clean degradation. |
| `--cwd /nonexistent` | `baka: cwd does not exist`, exit 1. |

### BROKEN

**B1. The documented `pnpm baka -- <cmd>` invocation is broken.**
`package.json:18` (`"baka": "pnpm --filter baka baka"`) forwards the literal `--`
to commander:

```
$ pnpm baka -- --help
error: unknown command '--help'
(Did you mean --lp?)
```

`pnpm baka <cmd>` (no separator) works. Every doc string that says
`pnpm baka -- <cmd>` is wrong as shipped.

**B2. `baka search` is dead by default — `api.baka.foo` does not exist.**
`src/lib/marketplace-client.ts:16` hardcodes `DEFAULT_API_URL = "https://api.baka.foo"`.
DNS: `api.baka.foo` and `baka.foo` are both NXDOMAIN. Live:

```
$ baka search typescript
baka: fetch failed        (exit 2, ENGINE_ERROR)
```

`runSearchCommand` (`src/commands/search.ts`) tolerates unreachable *community*
catalogs but has no try/catch around `getBuiltInCatalog`/`getVerifiedList`, so one
dead default host kills the whole command. `BAKA_API_URL` override works, but there
is nothing deployed to override *to* (`apps/api` exists with `vercel.json`; not deployed).

**B3. Bare-name `baka install <name>` can never resolve, and fails with the wrong error.**
Live:

```
$ baka install ts-style
baka: unrecognized source: "ts-style". Use npm:@scope/pkg[@ver], git:host/repo[@ref], ...   (exit 1)
```

`resolveModuleName` (`src/commands/marketplace.ts:43-57`) swallows *all* errors
(`catch { return null }`), so "the marketplace is unreachable" and "no such module"
are indistinguishable; the user gets the parse-error message instead of a
marketplace error. The registry mission builds directly on this path.

**B4. CRITICAL: `baka plan` always executes the plan. `--dry-run` and the absence of `--execute` do not prevent side effects.**
Causal chain: `runPlanCommand` (`src/commands/plan.ts:60`) calls
`featurePlanningWorkflow(intent, cwd, provider)` *before* looking at `opts.dryRun`
or `--execute`. The workflow (`workflows/feature-planning/src/plan-intent.ts`,
"2. EXECUTING — the SAGA runs the steps") calls `runSaga` unconditionally.

Live proof (`baka plan "scaffold a typescript project" --json`, no `--execute`,
cwd = repo root):

```
"[saga] step 1/2: baka-base v0.1.0:scaffold",
"[saga] step 2/2: ts-style v0.1.0:install-config",
"[saga] step 2 failed: action file .../ts-style/install-config/action.ts must export a WorkflowStep value named `install-config`...",
"[saga] rolling back 1 step(s) in reverse",
"[saga] compensating baka-base:scaffold"
```

The saga scaffolded into the repo root and rolled back via compensation
(repo verified clean after). A `--dry-run --json` probe in an empty dir showed the
saga ran there too ("[saga] all 0 steps completed"). Consequences:

- The `--dry-run` flag is a lie: it only suppresses the "(dry run...)" footer
  (`plan.ts` after the workflow returns).
- The `--execute` branch (`plan.ts`, "Phase 7") is dead code: execution already
  happened; the branch builds a `stepsByKey` map of `{}` placeholders and prints
  `use \`baka apply <plan-file>\` to execute a saved plan (coming online in Phase 7).`
- The human-mode footer `next: run \`baka plan --execute\` to run it.` is misleading —
  it already ran.
- MCP `baka_plan` inherits all of this (see M3).

**B5. CRITICAL: 3 of 7 shipped actions fail to load at runtime; `baka module validate` passes them anyway.**
`packages/ast-tooling/src/action-loader.ts` resolves a step by trying export names
`[actionId, actionId + "Action", "default"]`. For hyphenated action ids the first
two are not valid JS identifiers, and the in-repo modules use camelCase named exports:

| Action | Export in `action.ts` | Resolves? |
|---|---|---|
| baka-base:scaffold | `scaffoldAction` | yes |
| baka-base:add-script | `addScriptAction` | NO |
| baka-base:add-dependency | `addDependencyAction` | NO |
| ts-style:install-config | `installConfigAction` | NO |
| ts-style:lint | `lintAction` | yes |
| sdd:init-constitution | `export default step` | yes |
| sdd:create-feature | `export default step` | yes |

Live proof:

```
$ baka module test ts-style -a install-config
baka: .../install-config/action.ts must export an `ActionFn` named `install-config` (or `install-configAction` for legacy modules)
$ baka module test baka-base -a add-script
baka: .../add-script/action.ts must export an `ActionFn` named `add-script` (or `add-scriptAction` for legacy modules)
$ baka module validate ts-style --json   -> {"valid": true}   (exit 0)
```

`module validate` (`src/commands/module.ts:runModuleValidate`) checks that
`action.ts` *exists*, never that it is *loadable*. This exact failure is what
killed step 2 of the live plan run in B4. The same bug breaks the MCP tools
`baka_baka_base_add_script`, `baka_baka_base_add_dependency`,
`baka_ts_style_install_config` at call time (they register fine).

**B6. `baka plan` in a directory with no modules reports SUCCESS with zero steps.**
Empty intent is handled (`no module matched: empty intent`, exit 2), but an empty
module catalog is not: live probe returned `{"status":"SUCCESS","steps":[]}`,
exit 0. An agent cannot distinguish "plan succeeded" from "nothing matched".

### STUB

- `baka marketplace update` — self-described no-op (`marketplace.ts:runMarketplaceUpdate`,
  prints "(no-op in v1...)"). Exists for a future cron wiring.
- `baka plan --execute` — dead branch (see B4).
- MCP `baka_plan` `save` option — accepted by the schema, never used
  (`tools/workflow.ts:runPlan` takes `_opts` unused). Only the CLI persists plans.

### UX notes (not classified)

- A real 2-step plan against a *fast* local LLM took ~76 s; `--json` mode emits
  nothing until the very end, so the command looks hung (a 120 s foreground probe
  timed out before I ran it to completion in background).
- `module test` duplicates the action-loader candidate logic inline
  (`src/commands/module.ts`) including the "legacy `${actionId}Action` shape"
  narrative comment — two copies of a broken convention to fix.

### Tests

`pnpm --filter baka test`: **16 files, 165 passed, 1 skipped, ~11.4 s wall.**
Serial by design (`vitest.config.ts` `fileParallelism: false`) because
`baka-module-create.test.ts` rebuilds `apps/cli/dist` via `tsup --clean` while
smoke suites spawn that dist — comment in config is accurate. The 1 skip is the
`RUN_REAL_LLM=1`-gated real-LLM suite in `baka-module-create.test.ts` — a
legitimate gate, not a dodge. `marketplace.test.ts` / `search.test.ts` mock
`fetch` against real logic — honest. Gap: VAL-CLI-021 (`engine-smoke.test.ts`)
runs `plan --dry-run` against a fake LLM but only asserts the summary text; no
test anywhere asserts that dry-run produces zero filesystem effects (B4 would
have been caught by one).

---

## 2. apps/mcp (package `@baka/mcp-server`, bin `baka-mcp`)

### Live stdio probe (tsx against source, raw JSON-RPC)

- `initialize` → `protocolVersion: 2025-06-18`, `serverInfo: baka-mcp 0.1.0`,
  capabilities tools/resources/prompts (all `listChanged: true`).
- `tools/list` → 11 tools: `baka_plan`, `baka_apply`, `baka_validate`,
  `baka_list_actions`, plus 7 per-action tools (`baka_baka_base_scaffold`,
  `baka_baka_base_add_script`, `baka_baka_base_add_dependency`,
  `baka_sdd_init_constitution`, `baka_sdd_create_feature`,
  `baka_ts_style_install_config`, `baka_ts_style_lint`). Input schemas carry
  enums, required arrays, per-property descriptions. Tool names are valid
  snake_case within the 64-char MCP limit.
- `resources/list` → `baka://modules`; `resources/read` returns the directory JSON.
- `resources/templates/list` → `baka://module/{name}/manifest`; read of
  `baka://module/ts-style/manifest` returns the full manifest (1136 chars).
- `prompts/list` / `prompts/get baka_design_module` → 1 message, well-formed.
- `tools/call baka_validate` → payload `{modulesDiscovered: 3, validation: {kind: "fail"...}}`.
- `tools/call baka_list_actions {module:"ts-style"}` → `['install-config','lint']`.
- Stderr tool-call logging works: one structured JSON line per call
  (`{"source":"baka-mcp.tool","tool":"baka_validate","status":"ok"...}`).

### Findings

**SOLID** — the transport, registration, schema generation, resources, prompts,
stderr logging, and initialize guard all work as designed, and the e2e suite
proves it against the *built dist*, not tsx (see Tests).

**M1 (inherits B5).** The three per-action tools backed by camelCase exports
will throw the action-loader error on `tools/call`. They advertise fine.

**M2 (inherits B4).** `baka_plan` ignores `dryRun` and `save`
(`src/tools/workflow.ts:runPlan` — `_opts` unused) and *executes* the plan via
`featurePlanningWorkflow`. Its description says "Returns the resolved plan" and
never discloses that calling it mutates the project. For an agent-facing surface
this is the single most dangerous contract violation in the repo: an agent that
calls `baka_plan` with `dryRun: true` to "see what would happen" will run the
saga for real.

**M3.** `baka_validate` returns a `kind: "fail"` payload with `isError` unset —
a validation failure is a "successful" tool result. Defensible, but agent
clients must know to inspect the payload.

**M4 (minor).** Capabilities advertise `listChanged: true` for tools/resources/
prompts, but discovery is eager at startup (`src/context.ts:createContext`) and
no notification is ever emitted when the modules tree changes. Over-promise.

**M5 (minor).** `installInitializeGuard` uses a module-level `let initState`
(`src/server.ts`) — a second `startServer()` in the same process would inherit
"initialized". One server per process in practice.

**M6 (housekeeping).** `src/resources/modules.ts` keeps a `MODULE_MANIFEST_TEMPLATE`
"backwards-compat alias" with a `@lintignore` comment — the kind of legacy
breadcrumb the repo's own rules ban; nothing imports it.

### Tests

`pnpm --filter @baka/mcp-server test`: **3 files, 39 passed, ~3.9 s.**
`mcp-e2e.test.ts` (25 tests) is genuinely black-box: spawns
`apps/mcp/dist/index.js` over stdio, raw JSON-RPC frames, hermetic fake LLM on
`127.0.0.1:0`, mapped to a VAL-MCP-001..025 contract including malformed-frame
resilience, cwd sensitivity (11 tools in repo, 4 in empty dir), and CLI/MCP
shape parity (VAL-CROSS-010). Honest coverage — but note it never calls a
per-action tool to completion, so B5/M1 slip through.

---

## 3. What a registry/cloud mission would build on

1. **`marketplace-client.ts` is a thin, honest client** (4 endpoints, injectable
   fetch/baseURL, `BAKA_API_URL` override). The blocker is purely operational:
   the backend (`apps/api`, Vercel) is not deployed and the default domain is
   NXDOMAIN. Fix = deploy + set the real default, not more client code.
2. **Install resolution chain works end-to-end for `npm:`, `git:` (code-read),
   and local paths.** Only the bare-name hop (B3) is dead, and it fails with a
   misleading error because `resolveModuleName` swallows the transport error.
3. **The action space the registry would distribute is partially broken at
   runtime** (B5): any hyphenated action id with a camelCase export cannot be
   loaded by the engine, and `module validate` cannot see it. A registry that
   ingests community modules *must* gate on loadability, not on the current
   file-existence validation.
4. **The agent-facing execution contract is currently untruthful** (B4/M2):
   plan = execute, dry-run = execute. Any cloud flow that lets agents "preview"
   plans will destroy user projects until this is fixed.
5. The MCP server is the strongest, best-tested surface in the repo and is the
   right foundation to extend — after B4/B5.

---

## 4. Verdict table

| Command / tool | Verdict | Rationale |
|---|---|---|
| `list-modules` | keep | Works, honest diagnostics, JSON contract matches MCP resource. |
| `module validate` | fix | Passes unloadable actions (B5); must load the module and check export resolution. |
| `module list-actions` | keep | Works. |
| `module test` | fix | Works, but duplicates the broken export-name logic; share one loader. |
| `module create` / `module consistency` | keep (unproven live) | Interactive LLM flows; good unit + fake-LLM e2e coverage; real-LLM suite gated off by default. |
| `module edit` | keep | Trivial, works if `$EDITOR` set. |
| `init` / `role` / `roles` | keep | Clean role UX, correct exit codes, honest missing-config errors. |
| `plan` | fix | Executes unconditionally; `--dry-run` is a lie, `--execute` is dead code, empty-catalog plan returns SUCCESS (B4, B6). |
| `plan --execute` | cut | Dead branch; execution already happened upstream. Decide once: plan-only vs plan+execute. |
| `apply` | keep | Real SAGA path, JSON parity with MCP; not run live here (needs LLM + saved plan) but covered by tests. |
| `validate` | keep | Works live, correct exit codes, scoped `--module` filter. |
| `install <npm:/git:/local>` | keep | Verified end-to-end for npm and local. |
| `install <bare name>` | fix | Dead (NXDOMAIN backend) and misreports transport failure as a parse error (B3). |
| `remove` / `list-packages` / `update` | keep | Verified in temp project. |
| `marketplace add/list/remove` | keep | Works; honest tests. |
| `marketplace update` | cut | Self-described no-op; reintroduce when server-side warming exists. |
| `search` | fix | Hard-dies on the undeployed default host (B2); degrade gracefully per-endpoint. |
| `pnpm baka -- <cmd>` (root script) | fix | Forwards a literal `--` to commander (B1). |
| MCP `baka_plan` | fix | Ignores `dryRun`/`save`, executes the saga, description hides side effects (M2). |
| MCP `baka_apply` / `baka_validate` / `baka_list_actions` | keep | Verified live; payload semantics documented. |
| MCP per-action tools (`baka_<mod>_<action>`) | fix (3 of 7) | Registration/schema solid; `add_script`, `add_dependency`, `install_config` fail at call time (B5/M1). |
| MCP resources + `baka_design_module` prompt | keep | Verified live over stdio. |
| `marketplace-client.ts` | keep | Thin, injectable, honest; needs a deployed backend and a real default URL. |
