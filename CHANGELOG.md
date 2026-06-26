# Changelog

All notable changes to baka are recorded here. Dates use YYYY-MM-DD.

## [Unreleased] - 2026-06-26

### Fixed

- `apps/mcp/src/server.ts` hardcoded `const SERVER_VERSION = "0.1.0"`,
  so the MCP server's `initialize` response kept returning the stale
  `0.1.0` after `scripts/release.sh <version>` bumped the version.
  This silently broke VAL-CROSS-005 (versioning round-trip) and would
  have broken VAL-MCP-002 after any version bump. `SERVER_VERSION` is
  now read from `apps/mcp/package.json` at runtime via
  `import.meta.url`, mirroring the CLI's established pattern
  (`apps/cli/src/index.ts:30-36`). A focused regression test at
  `apps/mcp/test/version-source.test.ts` asserts both behaviorally
  (spawn the dist, send `initialize`, compare to package.json) and
  structurally (the dist must not contain the pre-fix hardcode token).
  Documented in `library/codebase-conventions.md` as the canonical
  "versioning source-of-truth" pattern for both CLI and MCP.
- `scripts/release.sh` invoked bare `pnpm pack`, which shadows the
  `pack` script in root `package.json` and produces a leaky tarball
  at the repo root (workspace deps that 404 on the npm registry).
  The actual pack call and the `--dry-run` plan text now both use
  `pnpm run pack` (the canonical wrapper that strips `workspace:*`
  deps and writes `dist-tarballs/`). The help text was updated for
  the same reason.
- `scripts/unlink-global.sh` did not include the pnpm 9 layout shim
  path (`/Users/lefamoffat/Library/pnpm/global/5/node_modules/.bin`)
  in `CANDIDATE_BIN_DIRS`, so the canonical uninstall script
  orphaned the shims when pnpm 9 placed them in the content-
  addressable store layout. The path is now covered (for both the
  hard-coded `/Users/lefamoffat` and the `$HOME`-prefixed form) so
  the script clears any orphan pnpm 9 shim on every pnpm version.
- The README install section documented `pnpm link --global`, which
  is a silent no-op when the workspace packages are
  `private: true`. The install flow now uses a new `pnpm
  link:global` script in root `package.json` that runs the
  per-workspace pattern
  (`pnpm --filter baka --filter @baka/mcp-server exec pnpm link
  --global`) and works under both pnpm 9 and pnpm 10.

### Added

- `link:global` script in root `package.json`:
  `pnpm --filter baka --filter @baka/mcp-server exec pnpm link
  --global`. The canonical per-workspace form that puts both
  `baka` and `baka-mcp` on `PATH` and survives the `private:
  true` guard that suppresses the top-level `pnpm link --global`.

## [Unreleased] - 2026-06-26

### Added

- Clean, installable tarballs for `baka` and `@baka/mcp-server`
  (M4-F2). `pnpm pack` produces `baka-<version>.tgz` and
  `@baka-mcp-server-<version>.tgz` with the right `package.json`,
  `bin`, `dist/`, `README.md`, and `LICENSE` — and without
  `test/`, `src/`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`,
  `.turbo/`, dev dependencies, or workspace-only `dependencies`
  (`@repo/*`, `@baka/*`, `baka-sdk`). The tsup config in
  `apps/cli/tsup.config.ts` now bundles `baka-sdk` (not just
  `@repo/*`) so the dist is self-contained. The
  `scripts/pack.mjs` wrapper rewrites the published manifest
  (drops workspace deps, devDeps, and the `private: true`
  guard) for the duration of the pack, then restores the
  source `package.json`.
- `files` field in `apps/cli/package.json` and
  `apps/mcp/package.json` restricting the published contents
  to `dist`, `README.md`, and `LICENSE`. Each app directory
  carries a copy of the root `README.md` and `LICENSE` so the
  field resolves at pack time.
- `scripts/unlink-global.sh`: idempotently removes the global
  `baka` and `baka-mcp` shims, regardless of which pnpm version
  (or install method) created them. Falls back from
  `pnpm unlink --global <pkg>` to `pnpm uninstall -g <pkg>` to
  a direct `rm -f` of the shim file, in that order. Used by
  the README uninstall section and the VAL-CROSS-008
  uninstall round-trip.
- `pnpm pack` now invokes `scripts/pack.mjs` for both
  workspaces, replacing the old direct `pnpm pack --filter`
  invocation. The wrapper is the canonical entry point for
  any tarball build.

### Verified (M4-F2 + M4-F3)

- `pnpm install -g` of both tarballs puts `baka` and
  `baka-mcp` on PATH (`which` returns real paths).
- `pnpm link --global` from the repo root achieves the same
  effect without installing from a tarball.
- `baka --help` and `baka-mcp initialize` work from `/tmp`,
  `$HOME`, and the repo root after link (cwd-independent).
- Re-running `pnpm link --global` is idempotent (single
  symlink per binary, no duplicate).
- Uninstall round-trip: unlink empties `which`; re-link
  restores; both binaries work after re-link.
- Clean-room install in `/tmp/baka-cleanroom` (no baka
  repo, no prior install): both tarballs install
  globally, `baka --version` returns 0.1.0, `baka-mcp
  initialize` returns the documented serverInfo.
- PATH-not-set failure: `PATH=/usr/bin:/bin baka` returns
  `command not found` with exit 127, the documented POSIX
  failure mode.

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
