# Critical Audit: First-Party baka Modules

Date: 2026-07-27
Scope: `modules/baka-base`, `modules/sdd`, `modules/ts-style`, checked against the stated contract in `docs/MODULES.md` and `docs/CATALOG-FORMAT.md`.
Method: every file read; all 7 shipped actions executed for real via the CLI's own `baka module test` runner and via direct jiti loads (the same mechanism the engine uses); module validators executed against real action outputs; sdd test suite executed. No files modified.

Classification legend: BROKEN / STUB / DEAD / UNTESTED / OVER-ENGINEERED / SOLID.

---

## Headline

**7 actions ship across the three modules. 3 of 7 cannot be loaded by the engine at all. 1 of 7 produces output that fails its own validator and its own `tsc`. 1 of 7 is a self-admitted stub. Only the 2 sdd actions work end-to-end, and both are useless without an LLM.** The CLI's own `baka module validate` reports all three modules `valid: true`, so the current screening bar would pass all of this into the registry unchanged.

Proof of the validation gap:

```
$ tsx apps/cli/src/index.ts module validate <name> --json    (for each of baka-base, sdd, ts-style)
{ "module": "baka-base", "valid": true,  "errors": [], "warnings": [] }
{ "module": "sdd",       "valid": true,  "errors": [], "warnings": [] }
{ "module": "ts-style",  "valid": true,  "errors": [], "warnings": [] }
```

---

## modules/baka-base

### BROKEN — `scaffold` does not produce `src/index.ts`; fails its own validator and its own `tsc`

The manifest promises `src/index.ts` (`modules/baka-base/manifest.ts:12,14` — description and `filePatterns`), and the README repeats it (`modules/baka-base/README.md:9`). The action writes only four files (`modules/baka-base/scaffold/action.ts:49-52`): `package.json`, `tsconfig.json`, `README.md`, `.gitignore`. No `src/index.ts` is ever created.

Executed for real (direct jiti load, same path as `packages/ast-tooling/src/action-loader.ts`):

```
scaffold success: true | createdFiles: [".../package.json",".../tsconfig.json",".../README.md",".../.gitignore"]
--- tree after scaffold ---
.gitignore  README.md  package.json  tsconfig.json        (no src/, no index.ts)
```

Consequences, all verified live:

1. Its own action validator `hasConsoleLog` (`modules/baka-base/scaffold/validators/has-console-log.ts:15-27`) errors on every scaffold run:
   ```
   [{ "severity": "error", "rule": "has-console-log",
      "message": "scaffold produced no src/index.ts at .../src/index.ts" }]
   ```
2. The generated `tsconfig.json` has `"include": ["src"]`; with no `src/` the project does not compile:
   ```
   $ tsc --noEmit   (in the scaffolded dir)
   error TS18003: No inputs were found in config file ... 'include' paths were '["src"]'
   exit=2
   ```
3. The generated `package.json` script `"start": "node dist/index.js"` (`scaffold/action.ts` renderPackageJson) points at a file that can never exist.
4. `filePatterns` feeds the planning verification phase (per `modules/README.md` rule 3), so the planner is told to expect a file the action never writes.

### DEAD — `add-script` and `add-dependency` cannot be loaded by the engine

`packages/ast-tooling/src/action-loader.ts:57` resolves the step by trying export names `` `${actionId}` ``, `` `${actionId}Action` ``, `default`. For action id `add-script` that candidate is the string `add-scriptAction`, which is not a valid JS identifier and matches nothing; the actions export camelCase `addScriptAction` / `addDependencyAction` and have no default export. Same for `ts-style/install-config` (`installConfigAction`). The CLI's `baka module test` duplicates this loader (`apps/cli/src/commands/module.ts:226-234`) and fails identically:

```
$ tsx apps/cli/src/index.ts module test baka-base --action=add-script --input='{"name":"build","command":"tsc"}'
baka: .../add-script/action.ts must export an `ActionFn` named `add-script` (or `add-scriptAction` for legacy modules)
exit=1

$ tsx apps/cli/src/index.ts module test baka-base --action=add-dependency --input='{"name":"zod","version":"^3.23.0"}'
baka: .../add-dependency/action.ts must export an `ActionFn` named `add-dependency` ...
exit=1
```

This propagates to every surface: the SAGA worker (`packages/ast-tooling/src/worker.ts:110-115` calls `loadAction`) and the MCP server, which registers one tool per action (`apps/mcp/src/server.ts:270-291`, `baka_baka_base_add_script` etc.) and executes through the same path. `scaffold` survives only because `scaffold` is a single word (`scaffoldAction` matches); sdd survives only because it uses `export default`.

Root cause: the loader never camelizes kebab-case action ids before appending `Action`, and no code path exercised these two actions before shipping (no tests exist in the module).

### SOLID (logic) — the dead actions' bodies are actually fine

Bypassing the loader and calling the steps directly:

```
add-script success: true | scripts: {"build":"tsc","start":"node dist/index.js","check":"tsc --noEmit","lint":"biome check ."}
add-dependency success: true true | deps: {"zod":"^3.23.0"} | devDeps: {"@types/node":"^22.0.0","typescript":"^5.9.0","vitest":"^4.1.8"}
```

Idempotent merge, correct dev-bucket routing, pinned ranges passed through, and compensation restores previous file content verbatim. The module's real defect is wiring, not logic.

### SOLID — module validators `hasPackageJson`, `tsconfigPresent`

Real checks (`modules/baka-base/_shared/validators/has-package-json.ts`, `tsconfig-present.ts`); both return `[]` on real scaffold output. `tsconfigPresent` is warning-only by design.

---

## modules/ts-style

### DEAD — `install-config` cannot be loaded

Same loader bug as above (`install-config` → candidate `install-configAction` ≠ exported `installConfigAction`):

```
$ tsx apps/cli/src/index.ts module test ts-style --action=install-config --input='{}'
baka: .../install-config/action.ts must export an `ActionFn` named `install-config` ...
exit=1
```

The logic itself works when invoked directly: writes strict `tsconfig.json` + `biome.json` (verified live, both files produced, strict flags honored).

### STUB + BROKEN — `lint` is a self-admitted stub, and its dependency chain is dead end-to-end

The manifest says it: `modules/ts-style/manifest.ts:24` — "Stub for Phase 6; full impl wires the validator chain in Phase 8" (repeated in `lint/action.ts:29-31` and `README.md:17`). This is the description the MCP server serves to every connected agent. Beyond being a stub, the chain cannot work:

1. In a fresh project it fails with `"biome.json not found; run ts-style.install-config first"` (verified via `baka module test`), and `install-config` is unloadable (above).
2. Even with `biome.json` present (written manually via the bypassed action), it fails because nothing ever installs biome:
   ```
   lint (biome.json present, biome NOT installed) success: false
   npm error npx canceled due to missing packages and no YES option: ["@biomejs/biome@2.5.5"]
   error: biome exited with code 1
   ```
   `install-config` writes `biome.json` but does not add `@biomejs/biome` to devDependencies, so `npx --no-install` (`lint/action.ts:34`) can never succeed in a project the module itself produced.
3. `stdio: "inherit"` (`lint/action.ts:36`) dumps raw biome output into the orchestrator's stream — no structured capture, contradicting the module's own "report findings" description.

Also note `ts-style` declares `dependencies: ["baka-base"]` (`manifest.ts:10`) but nothing in the engine installs or orders module dependencies, and the manifest's `category` is `"devops"` for sdd and `"pattern"` for ts-style while sdd is the spec-workflow module — cosmetic, but it is the metadata a registry would display.

### SOLID with one BROKEN edge — the three shared validators are real, not vacuous

Verified live against a dirty fixture (`src/bad.ts` with `x: any`, `console.log`, missing return type): `noAnyTypes` (error), `noConsoleLog` (warning), `explicitReturnTypes` (warning) all fire with correct file and count. They are regex-based and crude (the source admits it: `no-any-types.ts:21-23`), but functional.

One logic bug: `no-any-types.ts:7` puts `.test.ts` in `SKIP_EXTS` with the comment "Files we never inspect: test fixtures", but `extension()` (`no-any-types.ts:52-55`) returns only the last suffix (`.ts`), so the skip never matches. Verified live:

```
fixture: /tmp/baka-audit/testskip/foo.test.ts  ("export const x: any = 1")
noAnyTypes -> [{"severity":"error","rule":"no-any-types","message":".../foo.test.ts: 1 use(s) of `any`", ...}]
```

Test files are scanned despite the documented intent. `noConsoleLog` additionally walks every file that is not `.d.ts`/`.json`/`.md` (no extension allowlist), so lockfiles, templates, and binaries are read as text.

---

## modules/sdd

The strongest module by far — and the only one with tests.

### SOLID — both actions load, run, and are test-covered

`init-constitution` and `create-feature` execute successfully via `baka module test` (exit 0). Their templates (`create-feature/templates/*.hbs`, `init-constitution/templates/*.hbs`) are real, well-constructed LLM prompts with param interpolation — not placeholders.

Without an LLM, the actions write fallback stubs (`_TBD_`, `(not yet decided)`, `- TBD`), and — critically — the module's own validators detect exactly that and fail loudly (verified live):

```
constitutionCoherent on fallback output:
  error: specs/tech-stack.md is the action's fallback stub ... Re-run with a working LLM.
  error: specs/roadmap.md is the action's fallback stub ...
featureSpecCoherent on fallback output:
  error: specs/2026-07-27-audit-feature/plan.md is the action's placeholder body ...
  error: .../requirements.md is the action's placeholder body ...
  error: .../validation.md is the action's placeholder body ...
```

The validator-role LLM path also works end-to-end: with real (non-stub) content on disk and a validator role configured, `constitutionCoherent` made a live LLM call and returned four substantive semantic warnings about a deliberately thin constitution. Structural checks gate the LLM call (no wasted tokens on broken output), an unreachable model degrades to a warning, and a missing validator-role config hard-throws — exactly the behavior documented in the validator headers (`validators/constitution-coherent.ts:1-26`).

### UNTESTED (pipeline) — 26 tests exist and pass, but the repo's test runner never runs them

```
$ vitest run modules/sdd
 Test Files  6 passed (6)   Tests  26 passed (26)
```

But `modules/sdd/package.json` has no `test` script (only `check-types`), and turbo silently treats that as success:

```
$ turbo run test --filter=@baka-mod/sdd
 WARNING  No tasks were executed as part of this run.
 Tasks:    0 successful, 0 total
```

`pnpm --filter @baka-mod/sdd test` also exits 0 having run nothing. So root `pnpm test` is green while executing zero of the module's 26 tests. `baka-base` and `ts-style` ship no tests at all. All three modules pass `tsc --noEmit` (verified).

### DEAD (residue) — `out/templates/` dogfood artifacts inside the module source

`modules/sdd/create-feature/out/templates/*.hbs` and `modules/sdd/init-constitution/out/templates/*.hbs` are not copies of the templates; they are fully baked outputs from prior dogfood runs (a `module-packaging` feature spec, baka's own constitution), each carrying the engine's `{{!-- no-llm --}}` sentinel. They are untracked and covered by the root `.gitignore` `out/` entry, so they are not shipped — but their presence inside the module directory is confusing residue, and it corroborates the engine behavior below.

### Engine behavior that affects every reasoning module (context for the registry)

`packages/ast-tooling/src/worker.ts`:

- Line 86: the worker's output dir is `<targetDirectory>/modules/<module>/<action>/out/`.
- Line 102: the action's `templates/` folder is copied into the scratch dir unconditionally.
- Line 117: a non-empty scratch dir is copied into the target tree.
- Net effect: every `requiresReasoning` run drops a verbatim copy of the module's templates into the **user's project** under `modules/<module>/<action>/out/templates/`. Running sdd dirties the consumer's tree with module internals.
- Lines 248-252: if no LLM provider is injected, the worker **throws** for `requiresReasoning` actions. There is no degraded path at the engine level; the action-level fallbacks above only run when the caller bypasses the worker.

---

## Contract drift: docs/MODULES.md does not describe the real module API

`docs/MODULES.md:40-56` tells authors to `import { type ActionFn } from "baka-sdk"`, write `export const action: ActionFn = async (input, state) => ...`, and return declarative `ops: [{ kind: "writeFile", ... }]` for "the apply phase to materialize". None of this exists:

- `baka-sdk` (`packages/baka-sdk/src/index.ts`) exports no `ActionFn`.
- The protocol (`packages/protocol/src`) has no `ops`/`writeFile` concept; the real contract is `WorkflowStep` with `execute`/`compensate` (`packages/protocol/src/types.ts:45-53`), and actions write to disk directly with `node:fs`.
- The documented validator example uses a signature (`readIfExists`, `bakaProjectPaths`) that does not match the shipped validators' actual shape.

Any third-party author following the docs would produce a module the engine cannot load. The docs also never state the export-name rule (`${actionId}Action` or default) whose violation is what killed 3 of 7 shipped actions.

`docs/CATALOG-FORMAT.md` is internally consistent, but its trust model is provenance-only (`tier` = where the catalog came from): nothing in the format records whether a module loads, runs, or passes its own validators. This audit demonstrates provenance is not a quality signal — the `built-in` tier itself currently ships 3 dead actions and 1 self-invalidating one.

---

## Verdict table

| Module / action | Verdict | Rationale |
|---|---|---|
| baka-base / scaffold | fix | Loads and runs, but omits `src/index.ts`; fails its own validator and `tsc`; manifest `filePatterns` and README lie about the output |
| baka-base / add-script | fix | Logic verified solid; unloadable because the loader can't map kebab id `add-script` to export `addScriptAction` |
| baka-base / add-dependency | fix | Same loader bug; logic verified (dev bucket, pinned versions, idempotent merge) |
| baka-base / validators | keep | Real checks; `hasConsoleLog` correctly catches the scaffold bug (keep it, fix scaffold) |
| ts-style / install-config | fix | Unloadable (same loader bug); logic verified |
| ts-style / lint | cut (or rebuild now) | Self-admitted Phase 6 stub; chain dead end-to-end (install-config unloadable, biome never installed, `npx --no-install` fails, raw stdio) |
| ts-style / shared validators | keep | Real, fire correctly; fix `noAnyTypes` `.test.ts` skip bug and unfiltered file walk |
| sdd / init-constitution | keep | Works with LLM; fallback stubs are caught by its own validator; live validator-role LLM verified |
| sdd / create-feature | keep | Same |
| sdd / test suite | fix wiring | 26 tests pass but `package.json` has no `test` script; turbo/pnpm report green while running zero |
| sdd / `out/` residue | cut | Gitignored dogfood artifacts sitting inside module source; delete |
| docs/MODULES.md | fix | Documents a nonexistent `ActionFn`/`ops` API; omits the real export-name contract that broke 3 actions |
| Engine loader (`action-loader.ts`) | fix | Camelize kebab action ids or require `default` export; this one bug killed 43% of shipped actions |
| Engine worker `out/` pollution | fix | Copies module templates into the consumer's project on every reasoning run |

Net: **keep sdd (after wiring its tests), fix baka-base and the ts-style validators/config actions, cut or rebuild ts-style/lint before any registry listing.**

---

## Minimum useful module bar (what registry screening must enforce)

The audit shows the current bar — schema + layout validation — passes modules with 43% dead actions. A module should not be listable unless screening proves, in a sandbox:

1. **Loadability.** Every declared action resolves through the engine's real `loadAction` path. (Would have caught 3 of 7 actions.)
2. **Headless execution.** Every non-reasoning action executes against a scratch dir with fixture params and exits success. (Would have caught the lint chain.)
3. **Self-consistency.** The module's own validators run against the produced output and return zero errors; where the output is a project, its own toolchain runs (`tsc --noEmit`). (Would have caught scaffold.)
4. **Manifest truth.** `filePatterns` is a subset of the files the action actually writes; planning verification depends on it.
5. **Tests wired and run.** If the module ships tests, `package.json` has a `test` script and screening runs it — a green CI with zero executed tasks is not a pass.
6. **Reasoning actions are previewable.** `requiresReasoning` actions cannot be previewed without an LLM (worker throws at `worker.ts:248-252`). Screening needs either a recorded/fixture provider or the engine's existing `{{!-- no-llm --}}` sentinel pattern (`worker.ts:24`) so modules can ship pre-rendered preview outputs. A registry preview UI must handle "this module's real output requires an LLM" as a first-class state, not a crash.
7. **Sandboxed execution is mandatory.** Actions write directly to disk with `node:fs` (there is no declarative `ops` layer despite what the docs say), and the worker writes `out/` artifacts into the consumer's tree. Modules are arbitrary code; screening and preview must run in an isolated runner.

Implication for registry design: trust tiers in `docs/CATALOG-FORMAT.md` are provenance-based and carry no verification signal. Add a screening badge (loadable / executes / validators-pass / tests-run, with a timestamp and engine version) computed by CI executing the module, and require it even for the `built-in` catalog — which today would fail its own screening on 4 of 7 actions.
