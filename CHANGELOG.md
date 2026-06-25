# Changelog

All notable changes to baka are recorded here. Dates use YYYY-MM-DD.

## [Unreleased] - 2026-06-25

### Added

- Engine-surface smoke test suite at `apps/cli/test/engine-smoke.test.ts`
  covering `baka module *` (create, validate, list-actions, test), the
  `plan`/`list-plans`/`apply`/`validate` flow, and the cross-area
  `-p <provider>` non-mutation guarantee. All probes spawn the built
  `apps/cli/dist/index.js`; LLM-bound probes route through a hermetic
  fake harness bound to `127.0.0.1:0`.

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
