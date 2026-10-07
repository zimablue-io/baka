# Engine Audit — packages/protocol, agent-engine, ast-tooling, baka-sdk, workflows/*

Date: 2026-07-27. Scope: audit only, no files modified. Method: read every source file in scope, ran each package's own test script, traced the plan/apply flow through apps/cli + apps/mcp, and ran a live reproduction for the SAGA compensation path.

## Test run summary (all green)

| Package | Command | Result |
|---|---|---|
| @repo/protocol | `pnpm --filter @repo/protocol exec tsc --noEmit` | EXIT:0 (no test script) |
| @repo/agent-engine | `pnpm --filter @repo/agent-engine test` | 6 files, 51 tests passed |
| @repo/ast-tooling | `pnpm --filter @repo/ast-tooling test` | 8 files, 31 tests passed |
| baka-sdk | (no test script, no test files) | UNTESTED |
| @repo/discovery-workflow | `pnpm exec vitest run src/discovery.test.ts` (no `test` script in package.json) | 5 tests passed |
| @repo/feature-planning-workflow | `pnpm --filter @repo/feature-planning-workflow test` | 1 test passed (near-tautological, see below) |
| @repo/module-management-workflow | `pnpm --filter @repo/module-management-workflow test` | 5 files, 94 tests passed |

---

## packages/protocol — SOLID

Pure zod schemas, types, constants. No tests, but there is nothing to test beyond the schema shapes, which are exercised indirectly by every consumer's tests. `tsc --noEmit` passes.

- `ENGINE_STATUS`, `BAKA_EXIT_CODE`, `BAKA_PROJECT_PATHS`, `BAKA_USER_DIR` (src/constants.ts) — consumed everywhere. Fine.
- `AgentRole.VALIDATOR` (src/types.ts:24) is reserved-but-unused, suppressed in knip.jsonc `ignoreMembers`. Harmless, but it is spec inventory, not code.
- `MODULE_CATEGORY` (src/constants.ts:33-40) — comment says "exist only for documentation and example prompts, never for enforcement". Dead weight; DEAD-adjacent.

Verdict: keep as-is. This is the one package the registry mission can build on blind.

---

## packages/agent-engine

### 1. config/store.ts + loadLLMConfig — SOLID
Role-keyed `~/.baka/config.json`, hard-fails with `BAKA_CONFIG_MISSING` when absent (src/index.ts:60-98). 51 tests pass, including adversarial "battle" suites against legacy config shapes. This is the most battle-tested code in the repo.

### 2. providers/openai-compatible.ts — SOLID
Single OpenAI-compatible adapter: constrained decoding via `response_format: json_schema`, one repair retry, hand-rolled zod→JSON-schema (src/providers/openai-compatible.ts:199-221). 5 tests pass with mocked fetch. The hand-rolled `toJsonSchema` only handles object/string/number/boolean/array/enum/optional/record/any — sufficient for current schemas, fragile if schemas grow (union, literal, nullable silently fall through to `{type:"object"}` at line 220). OVER-ENGINEERED-adjacent but acceptable.

### 3. createOrchestratePlanningStep — SOLID code, LLM-MANDATORY flow
src/index.ts:150-226. Real and wired: `featurePlanningWorkflow` (workflows/feature-planning/src/plan-intent.ts:16) calls it with the provider built in `apps/cli/src/commands/plan.ts:44-51` and `apps/mcp/src/tools/workflow.ts:53`.

**With no LLM configured (the common case):** `loadLLMConfig` throws `missing LLM config: worker role not configured` (src/index.ts:66-70); plan.ts:37-40 catches and exits `USER_ERROR (1)`. There is no deterministic planner fallback. Planning is 100% LLM.

**The "deterministic" claim is aspirational.** README.md: "The same intent + the same modules always produce the same plan." In reality: temperature 0.0 is set (src/index.ts:165) and `normalizePlan` (src/index.ts:262-277) cleans up small-model param wrapping, but nothing enforces plan stability, and the entire consistency.ts subsystem exists precisely because runs drift. The deterministic parts are real (registry, layout validation, deterministic validators, SAGA mechanics, plan-io); the planning step is not deterministic, only LLM-constrained.

### 4. loadModulePreferences (PREFERENCES.md inlining) — SOLID but fragile
src/index.ts:288-310. Really used: called from `buildPlanningPrompt` (line 231), tested by preferences-path.test.ts (1 test, passes). Fragility: reads from `process.cwd()` rather than the plan's target directory, so it breaks if the CLI is invoked with `--cwd` different from the shell cwd.

### 5. module-design.ts — DEAD (duplicate of module-management)
src/module-design.ts (461 lines: `createModuleDesignStep`, `DesignTurnPayloadSchema`, `renderManifestSource`, `renderActionStubSource`, `renderValidatorStubSource`, `renderTemplateStubSource`, `renderPreferencesFile`). Repo-wide grep shows the ONLY consumers are its own test file and the re-export in src/index.ts:362-370. The CLI's module-design commands import the parallel implementation in `workflows/module-management/src/design/*` (apps/cli/src/commands/module-design/run.ts:19-21 imports `runChatLoop` from `@repo/module-management-workflow`). The two copies have already diverged (agent-engine's SYSTEM_PROMPT_HEADER is ~50 lines; module-management's design/llm.ts:34 is one sentence; both define their own `DesignTurnPayloadSchema` — agent-engine line 101 vs module-management design/payload.ts:79). This is structural legacy: two sources of truth for the same LLM contract, one of them dead. DEAD.

---

## packages/ast-tooling

### 1. registry.ts (ModuleRegistry) — SOLID
Discovery across 4 scopes (tree / project `.baka/modules` / user `~/.baka/modules` / bundled), layout enforcement, topological `resolveOrder`, structural `validate`. 5 tests pass with real temp projects (registry.test.ts, registry-user-scope.test.ts). The bundled-scope walk-up anchored on `modules/baka-base/manifest.ts` (lines 53-77) is duplicated verbatim in worker.ts:192-209 and workflows/discovery/src/discovery.ts:14-31 — three copies of the same marker hunt. OVER-ENGINEERED by duplication, but each copy works.

### 2. action-loader.ts — SOLID, one DEAD export
jiti-based loading of actions/validators/helpers. Exercised for real by worker tests (which load actual action.ts files via jiti). `loadSharedHelper` (lines 123-133) has zero consumers repo-wide — DEAD. Note action-loader.ts:48-49 keeps a "legacy `${actionId}Action` shape" fallback for old modules; baka-base still uses it, so it is load-bearing today.

### 3. worker.ts — SOLID execution, BROKEN compensation contract, misleading sandbox
Execution path is genuinely tested end-to-end (worker.test.ts builds a real project, loads action via jiti, runs through `runSaga`; worker-reasoning.test.ts covers the requiresReasoning template fill with a fake provider; worker-init-message.test.ts pins the no-provider error).

Problems:
- **Scratch sandbox is decorative.** The action's `execute` receives the real `state.targetDirectory` and writes directly into the user tree (worker.test.ts's own fixture action writes `state.targetDirectory/name.txt`). The scratch dir only ever holds a copy of `templates/` (worker.ts:88-89), which is then copied into `modules/<mod>/<action>/out` (lines 112-114) — meaning every reasoning action pollutes its own module folder with a template copy under `out/`. The docstring's "runs it against a fresh scratch dir, copies the result into the real target tree" (lines 57-60) does not describe what happens.
- **Compensation contract broken in production — see the BROKEN finding under saga.ts below.**
- worker-init-message.test.ts:109-110 asserts the error does NOT contain the legacy `baka providers use` hint — an absence-pin against deleted behavior.

### 4. saga.ts + worker.ts — BROKEN: rollback never compensates in production wiring

Causal chain:
1. Production registers the generic Worker step for every action: `stepsByKey.set(..., executeWorkerStep)` in apps/cli/src/commands/plan.ts:170, workflows/feature-planning/src/plan-intent.ts:36-38, apps/mcp/src/tools/workflow.ts:86.
2. On success, the saga stores `unwrapWorkerCompensation(result.compensationData)` (saga.ts:97-101), which strips the `WorkerRollbackData` envelope down to the action's inner compensation data (saga.ts:42-50).
3. On rollback, the saga calls `c.step.compensate(c.compensationData)` (saga.ts:148) — i.e. **the Worker's compensate receives the action's data**, not the envelope.
4. `executeWorkerStep.compensate` (worker.ts:149-160) reads `data.outputDir` / `data.scratchDir`, both now `undefined`; `existsSync(undefined)` no-ops (DEP0187 warning on modern Node), so **no scratch/output cleanup happens, and the action's own `compensate` is never invoked by anyone**.

Live reproduction (tsx against workspace sources, temp project with a real jiti-loaded action + failing second step):
```
WORKER COMPENSATE received data: {"path":"/var/.../baka-comp2-XXX/x.txt"}
status: FAILED
x.txt SURVIVED rollback
```
"ACTION COMPENSATE CALLED" never printed; the produced file stayed on disk.

**Why the tests don't catch it:** worker.test.ts:158-178 ("rolls back the produced file") registers the RAW action step in `stepsByKey`, not `executeWorkerStep` — with a raw step, `unwrapWorkerCompensation` is a pass-through and the action's compensate works. saga.test.ts uses fake steps without the envelope. No test exercises `runSaga` + `executeWorkerStep` + a failing later step, which is the only wiring production uses.

The unwrap exists to feed validators (validator.ts:12-15 comment; plan.ts:186-190 actionResults). The fix is to keep the envelope for rollback and expose the unwrapped view to validators separately, or have `executeWorkerStep.compensate` call the action's compensate itself.

### 5. validator.ts (runValidators) — SOLID
Structural + module-level + action-level validators, `moduleFilter` for the apply path. Used by CLI plan/validate and MCP. Validator failures are folded into diagnostics, never throw. Not directly unit-tested, but exercised indirectly; the load-path is covered by worker/registry tests. UNTESTED (direct) but low-risk.

### 6. plan-io.ts — SOLID
save/load/list of `.baka/plans/*.plan.json`. Minimal, used by plan.ts. Fine.

### 7. structured-log.ts — SOLID (trivial)
Append-only JSONL to `~/.baka/logs/`. Used by plan.ts:55,149. Fine.

### 8. marketplace-catalogs.ts — SOLID
`~/.baka/catalogs.json` CRUD with URL validation. 10 meaningful tests pass. Consumed by apps/cli/src/commands/marketplace.ts:169. Directly relevant to the registry mission.

### 9. package-manager.ts — SOLID core, sloppy edges
`parseSource` (npm:/git:/URL/local) + settings + install/remove/list/update. Consumed by marketplace.ts. Edges:
- `installFromNpm` (lines 333-373) shells out to `npm pack` + `tar`, leaves dead `void writeFileSync / void readdirSync / void readFileSync / void existsSync` statements (lines 369-372) to silence unused imports.
- `updateOne` (lines 305-315): pinned sources are a deliberate no-op — "We no-op for now; full reconciliation can run `git fetch && git reset --hard <ref>`". Partial STUB.
- Git ref parsing (lines 56-67, 185) is fragile: for `https://` URLs the ref regex `[@#]...$` and `installSource`'s `parsed.raw.split("@").pop()` disagree with `parseSource`'s `cleanUrl`.
- No unit tests for parseSource at all. UNTESTED.

### 10. consistency.ts — OVER-ENGINEERED + latent portability bug
- Spawns the real `baka` binary N times per run (lines 145-172): full end-to-end drift test, expensive, depends on a `baka` on PATH.
- `hashTree` (lines 208-230) calls `require("node:child_process")` inside a `"type": "module"` package and shells to `find`. Works today only because every runtime that reaches it (vitest transform, tsx, the tsup ESM bundle's `__require` shim — verified in apps/cli/dist/index.js:230) papers over it. Pure Node ESM would crash.
- Test-only helpers `computeDivergencesForTest` / `renderConsistencyTraceForTest` (lines 234-283) live in the production file and are exported through the barrel; the private `computeDivergences`/`writeConsistencyTrace` just forward to them. Inverted dependency: production delegates to test hooks.
- `CONSISTENCY-TRACE.json` (line 287) contains markdown prose, not JSON (the JSON twin is `CONSISTENCY.json`). Misnamed artifact.
- consistency.test.ts only tests the divergence/trace helpers — `runConsistencyTest` itself (the spawn-the-binary part) is UNTESTED.

---

## packages/baka-sdk — mostly re-exports, UNTESTED, small DEAD tail

src/index.ts. The type/re-export surface (WorkflowStep, AgentRole, schemas) is the right boundary and is genuinely used by modules (`modules/sdd/*/validators/*.ts` import `callLLMAsValidator`). No test script, no tests.

- `callLLMAsValidator` / `loadLLMProvider` (lines 117-147): real, used by modules/sdd validators. SOLID.
- `bakaProjectPaths` (line 56), `readIfExists` (line 70), `bakaUserDir` (line 78): zero consumers repo-wide. DEAD. Also `bakaProjectPaths` hardcodes `.baka` strings that duplicate `BAKA_PROJECT_PATHS` from protocol.

---

## workflows/discovery — SOLID but REDUNDANT and scope-inconsistent

src/discovery.ts re-implements `ModuleRegistry.discover` with fewer scopes: it scans tree + bundled + user, but **not** the project marketplace scope `<root>/.baka/modules` (compare registry.ts:97-101, which has all four). Consequence: a module installed via `baka marketplace add` into the project scope is invisible to `baka plan` (plan.ts:4 → featurePlanningWorkflow → discoverModules) but visible to `baka apply`/`baka validate` internals (ModuleRegistry). `runValidateCommand` (plan.ts:222) even mixes both: `modulesDiscovered` from discovery.ts, validation from registry.ts — the two counts can disagree. BROKEN (scope inconsistency) / OVER-ENGINEERED (two discovery implementations to maintain). Tests: 5 meaningful tests pass (temp dirs, mocked homedir), but the package has no `test` script so they don't run in `pnpm -r test`.

## workflows/feature-planning — SOLID glue, trivial test

src/plan-intent.ts is thin, correct glue: discover → orchestrator step → build stepsByKey with `executeWorkerStep` → `runSaga`. Its single test (plan-intent.test.ts) mocks `@repo/agent-engine`, `@repo/ast-tooling`, `runSaga`, and the registry, then asserts the mocked saga's own SUCCESS status — a tautology that would pass with almost any implementation. UNTESTED (meaningfully).

## workflows/module-management

### design/* — SOLID
chat/state/slash/hooks/payload/llm/render: 94 tests pass, tests assert real behavior (state machine transitions, slash commands, hook delivery). This is the live module-design subsystem the CLI uses.

### create-module.ts — DEAD + spec-violating
`executeCreateModuleWorkflow` (src/create-module.ts) has no production consumer; only apps/cli/test/barrel-*.test.ts assert `typeof === "function"` (existence pins, not behavior). Its own test (create-module.test.ts) mocks `node:fs` and `node:path` wholesale and asserts mkdirSync was called — a tautology. The generated manifest imports `@repo/protocol` directly (create-module.ts:21), violating the package's own rule that modules import only `baka-sdk` (baka-sdk/src/index.ts:9). The `"use workflow"`/`"use step"` directives (workflow@4.4.0) are declared but the workflow runtime is not wired anywhere; knip.jsonc suppresses the dependency as "genuinely required" for directives that compile to nothing in the current build. DEAD.

---

## Cross-cutting

- `baka plan --execute` in apps/cli/src/commands/plan.ts:113-127 is a STUB: builds a `stepsByKey` map of `{} as WorkflowStep` placeholders, prints "coming online in Phase 7", and defers to `baka apply`. CLI-scope, but it borders the engine story.
- Discovery walk-up marker (`modules/baka-base/manifest.ts`) duplicated in 3 files.
- No TODO/FIXME anywhere in packages/ (grep clean). "Phase N" comments in CLI/workflows are stale roadmap prose.

---

## Verdict table

| Subsystem | Verdict | Rationale |
|---|---|---|
| protocol (schemas/types/constants) | keep as-is | Only package safe to build on blind |
| agent-engine config/store + loadLLMConfig | keep as-is | Most battle-tested code in the repo (51 tests) |
| agent-engine OpenAICompatibleProvider | keep as-is | Works; watch hand-rolled toJsonSchema as schemas grow |
| agent-engine createOrchestratePlanningStep | keep as-is | Real and wired; drop "deterministic plan" marketing or enforce it |
| agent-engine loadModulePreferences | fix | Works but reads process.cwd(), breaks with --cwd |
| agent-engine module-design.ts | cut | Dead duplicate of module-management design/*; diverged |
| ast-tooling ModuleRegistry | keep as-is | Solid, tested; the registry mission's foundation |
| ast-tooling action-loader (jiti) | keep as-is | Real, tested; cut dead loadSharedHelper |
| ast-tooling saga+worker compensation | fix | BROKEN: envelope unwrap means rollback never compensates in production wiring (reproduced live) |
| ast-tooling worker scratch sandbox | simplify | Sandbox is decorative; actions write to the real tree; templates leak into modules/*/out |
| ast-tooling runValidators | keep as-is | Solid; add direct unit tests |
| ast-tooling plan-io, structured-log, marketplace-catalogs | keep as-is | Small, tested, directly reusable by registry/cloud |
| ast-tooling package-manager | fix | Core is right; add parseSource tests, remove `void` dead code, finish pinned-update stub |
| ast-tooling consistency.ts | simplify | Test hooks in prod file, `require`+`find` in ESM, misnamed trace artifact, runner itself untested |
| baka-sdk | simplify | Boundary is right; cut bakaProjectPaths/readIfExists/bakaUserDir; add smoke test |
| workflows/discovery | fix (merge into ModuleRegistry) | Missing project-marketplace scope; duplicate of registry discovery |
| workflows/feature-planning | keep as-is (code), replace test | Glue is fine; the one test is a tautology |
| workflows/module-management design/* | keep as-is | Live, well-tested (94 tests) |
| workflows/module-management create-module.ts | cut | No consumer, tautological mocked test, violates baka-sdk boundary, unused workflow directives |

## What the registry/cloud mission can safely build on

Registry discovery (ModuleRegistry), manifest schema, jiti action loading, runValidators, plan-io, marketplace-catalogs, package-manager (with the fixes above), config store, OpenAI-compatible provider, baka-sdk boundary. Do NOT build on: saga rollback (broken until the compensation envelope is fixed), discovery.ts's module list (scope-inconsistent), agent-engine's module-design (dead), create-module.ts (dead), or the "deterministic plan" claim (unenforced).
