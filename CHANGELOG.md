# Changelog

All notable changes to baka are recorded here. Dates use YYYY-MM-DD.

## [Unreleased] - 2026-06-26

### Added

- MCP end-to-end test suite at `apps/mcp/test/mcp-e2e.test.ts` that
  spawns `apps/mcp/dist/index.js` over stdio and exercises every
  JSON-RPC surface: `initialize`, `tools/list`, `tools/call`
  (happy and sad paths), `resources/list`+`resources/read`+
  `resources/templates/list`, `prompts/list`+`prompts/get`, malformed
  JSON-RPC resilience, concurrent-init rejection, cwd sensitivity,
  and structured stderr log discipline. Also covers the cross-area
  CLI `--json` vs MCP `tools/call` plan/apply shape parity. Probes
  bind the fake LLM to `127.0.0.1:0`; LLM-bound cases route through
  a hermetic fake harness.
- One structured stderr log line per successful `tools/call` in
  `apps/mcp/src/server.ts` (VAL-MCP-025). The line is tagged with
  the tool name and a per-call id; stdout is untouched (the JSON-RPC
  stream lives there).
- Concurrent `initialize` requests are rejected cleanly
  (VAL-MCP-023). The default MCP SDK behavior was to accept them; the
  guard now returns a structured `-32600` "server already initialized"
  error and `tools/list` continues to work afterwards.

## [Unreleased] - 2026-06-25

### Added

- Engine-surface smoke test suite at `apps/cli/test/engine-smoke.test.ts`
  covering `baka module *` (create, validate, list-actions, test), the
  `plan`/`list-plans`/`apply`/`validate` flow, and the cross-area
  `-p <provider>` non-mutation guarantee. All probes spawn the built
  `apps/cli/dist/index.js`; LLM-bound probes route through a hermetic
  fake harness bound to `127.0.0.1:0`.
- `knip.jsonc` at the repo root (M3-F3). The config declares every
  workspace's entry and project globs, ignores module action / validator
  files loaded dynamically via `jiti`
  (`packages/ast-tooling/src/action-loader.ts`), suppresses the
  `workflow` dependency that is consumed through the `"use workflow"`
  and `"use step"` directives, and turns on
  `ignoreExportsUsedInFile` to silence internal-only re-exports.
  `pnpm knip` now exits 0 (VAL-CI-008).
- Project-local `PostToolUse` hook in `.factory/settings.json`
  (M3-F4, VAL-DOC-015). A thin Node helper at
  `.factory/hooks/biome-format.mjs` runs `biome check --write` on every
  `Edit|Write|MultiEdit` of a formattable file (TS / TSX / JS / JSON).
  Universal hooks (SessionStart, UserPromptSubmit, Stop) remain
  inherited from `~/.factory/settings.json` via the documented
  extension-only merge; the project-local file now contributes one
  real hook instead of `{}`.

### Fixed

- `packages/ast-tooling/test/marketplace-catalogs.test.ts` was moved to
  `packages/ast-tooling/src/marketplace-catalogs.test.ts` (M3
  scrutiny-flagged dead test). The vitest include glob
  (`packages/ast-tooling/vitest.config.ts`) is `src/**/*.test.ts`, so
  the file was silently outside the test suite; `pnpm --filter
  @repo/ast-tooling test` now runs the full 10 tests (the original 8
  plus the two added during recon).
- `VALIDATOR` member of `AgentRole` (`packages/protocol/src/types.ts`)
  is now tagged `@lintignore` so it stays in the public protocol
  shape without surfacing as a knip finding. The enum is part of the
  public API contract; removing the member would be a breaking change.

### Changed

- `apps/mcp/src/resources/modules.ts`: `MODULE_MANIFEST_TEMPLATE` is
  tagged `@lintignore` and kept as a backwards-compat alias for
  `MODULE_MANIFEST_TEMPLATE_METADATA`.
- `packages/agent-engine/src/config/store.ts`: `CURRENT_PLATFORM` and
  `IS_WINDOWS` are tagged `@lintignore`. They are part of the package's
  public surface for downstream consumers that need cross-platform
  config paths; nothing in the monorepo reads them today.
- `packages/protocol/src/constants.ts`: the `EngineStatus`,
  `BakaExitCode`, `BakaProviderName`, and `ModuleCategory` types are
  tagged `@lintignore`. They are the `keyof typeof` companion to
  public protocol constants; external tools (dashboards, scripts)
  consume them by name.
- `apps/cli/package.json` and `apps/mcp/package.json`: the recon pass
  removed dead dependencies and devDependencies
  (`conf`, `esbuild`, `@repo/module-management-workflow` in apps/mcp,
  `jiti` in apps/mcp). These were declared but not imported; `pnpm
  knip` was the validation gate that confirmed the removals.

## [Unreleased] - 2026-06-25

### Added

- Engine-surface smoke test suite at `apps/cli/test/engine-smoke.test.ts`
  covering `baka module *` (create, validate, list-actions, test), the
  `plan`/`list-plans`/`apply`/`validate` flow, and the cross-area
  `-p <provider>` non-mutation guarantee. All probes spawn the built
  `apps/cli/dist/index.js`; LLM-bound probes route through a hermetic
  fake harness bound to `127.0.0.1:0`.

### Fixed

- Closed the VAL-CLI-023 contract gap in `apps/cli/src/commands/plan.ts`:
  `baka plan '<intent>' --save --json` now writes
  `.baka/plans/<file>.plan.json` AND emits the documented
  `{status, steps, logs}` JSON contract. The save branch now runs before
  the JSON-mode early-return, and the JSON output gains optional
  `planFile` and `savedAt` fields when `--save` is applied. The
  `--save-alone` workaround in `engine-smoke.test.ts` (VAL-CLI-023,
  VAL-CLI-025, VAL-CLI-027) was replaced with the contract-true
  `--save --json` invocation.

### Changed

- Vitest now runs test files serially in the `baka` package
  (`apps/cli/vitest.config.ts`). The previous default (parallel across
  files) intermittently triggered a `MODULE_NOT_FOUND` race when the
  `baka-module-create.test.ts` `beforeAll` rebuild cleaned the dist
  while a sibling file was spawning the CLI subprocess. Running serially
  removes the race with a small (~7s) wall-clock cost.
- Archived `docs/PRD.md` and `docs/ROADMAP.md` to `docs/ARCHIVE.md`;
  canonical content now lives under `specs/`
  (`specs/mission.md`, `specs/roadmap.md`, and per-feature folders
  under `specs/YYYY-MM-DD-<name>/`).
- Landed the in-progress `packages/ast-tooling` refactor: Worker now
  renders Handlebars templates through the injected LLMProvider with a
  zod-constrained schema; SAGA normalizes the planner's version-suffixed
  module names; ModuleRegistry supports user-scope and project-marketplace
  dedup with symlink resolution; action loader now resolves
  action-level and module-level validators from kebab-case filenames.
- Fixed `packages/agent-engine` import path: `openai-compatible` now
  resolves from `./providers/openai-compatible.js` (matches the actual
  file location after the providers split).
- Inlined a minimal `loadSession` equivalent in
  `apps/cli/src/commands/module-design/consistency.ts` to work around
  the tsx ESM static-analysis issue when Node cannot verify named
  exports from a `.ts` package entry.
