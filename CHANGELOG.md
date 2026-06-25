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
