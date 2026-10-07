# Baka — Agent Guide

This document is the cross-package agent guide for the baka monorepo. It is the source of truth that package-level `AGENTS.md` files reference.

## Workspace layout

```
.
├── apps/cli/                # The baka binary (package name: baka)
├── apps/mcp/                # The baka-mcp binary (package name: @baka/mcp-server)
│
├── workflows/               # Engine orchestration for THIS project
│   ├── feature-planning/    # Plan user intents into module actions
│   └── module-management/   # Scaffold new modules
│
├── packages/                # Engine tools (low-level nodes)
│   ├── protocol/            # SSOT: types, schemas, LLMProvider interface, exit codes
│   ├── agent-engine/        # The ONLY package that knows what an LLMProvider is
│   ├── ast-tooling/         # File/AST operations, ModuleRegistry (Phase 3)
│   └── core/                # @baka/core: the published, embeddable library surface
│
├── modules/                 # User-defined patterns (action-centric layout)
│
├── docs/                    # Philosophy, specs, agent guide
├── SKILL.md                 # Declarative agent contract (consumed by Claude Code, Codex, Cursor, etc.)
│
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## Layer rules (invariants)

1. `protocol` is leaf — no imports from any other baka package. Pure types and Zod schemas.
2. `agent-engine` is the **sole** package allowed to import an LLM provider implementation. Other packages import the `LLMProvider` interface from `protocol` only.
3. `ast-tooling` is FS- and tree-aware. It does not know about LLMs.
4. `workflows/` orchestrate by calling `agent-engine` (for LLM work) and `ast-tooling` (for FS work). Workflows do not import concrete providers.
5. `packages/core` is the published library facade. It re-exports from `protocol` and `ast-tooling` only (never `agent-engine`, never an app), reads no process-global config (`~/.baka`) unless the caller opts in, and the caller injects the `LLMProvider`.
6. `apps/cli` is thin: command parsing, output formatting, dispatch to workflows. The `baka` binary is a user-facing shell.
7. `apps/mcp` is thin: an MCP server over JSON-RPC on stdio. The `baka-mcp` binary is the agent-facing transport. It depends on `packages/*` and `workflows/*` directly; it does NOT depend on `apps/cli/` and does NOT shell out to the `baka` binary. The two apps are leaves that share the same SSOT.

**The grep test** that proves the provider boundary is intact:

```bash
grep -rE "api\.openai|api\.anthropic|@anthropic-ai/sdk|@earendil-works/pi-coding-agent|from \"openai\"|from 'openai'" packages/ workflows/ apps/ --include="*.ts" --exclude="*.test.ts" | grep -v "agent-engine/"
```

This MUST return zero matches. If it doesn't, the boundary is leaking — file a regression and stop. The pattern targets LLM provider SDKs and provider API hosts specifically; non-test source may legitimately contain other URLs (marketplace catalog config, fixture hosts), which are not boundary leaks, and test files may reference provider names when they assert the boundary itself.

## Per-package pointers

| Package | Read first | Owns |
|---|---|---|
| `apps/cli` | this file, `docs/PHILOSOPHY.md` | CLI command surface (`init`, `role`, `roles`, `plan`, `apply`, `validate`, `module`), output formatting, exit codes, `--json` flags |
| `apps/mcp` | this file, `docs/PHILOSOPHY.md` | MCP server (stdio JSON-RPC), tool/resource/prompt registration, `--json` parity with CLI |
| `.agents/rules/` | this file, `.agents/README.md` | Harness-agnostic coding rules any agent should follow. |
| `docs/research/` | this file | Dated engineering audits and architecture research. Human-facing, not agent-plumbing. |
| `.mcp.json` | this file | **Project-scoped MCP registration.** Source of truth for which MCP servers are wired into this repo. Edit and commit to add/remove servers for the team. Your own user-level config can hold personal entries. |
| `workflows/feature-planning` | this file, `docs/PHILOSOPHY.md` | Orchestrator durable step + Worker loop |
| `workflows/module-management` | this file, `docs/PHILOSOPHY.md` | `baka module create` workflow, double-diamond design flow |
| `packages/protocol` | this file, `docs/PHILOSOPHY.md` | All types, schemas, constants, exit codes, `LLMProvider` interface |
| `packages/agent-engine` | this file, `docs/PHILOSOPHY.md` | `createLLMProvider`, `loadLLMConfig({ role, cwd, overrides? })`, `createOrchestratePlanningStep`; the ONLY package that talks to an LLM |
| `packages/core` | this file, `packages/core/README.md` | The published `@baka/core` entry point: `runAction`, `validate`, `describeModules`, `createRegistry`, result and receipt types |
| `packages/ast-tooling` | this file, `docs/PHILOSOPHY.md` | `executeAstTransformationStep`, `ModuleRegistry` (the single module-discovery implementation: project marketplace, tree, user marketplace, bundled scopes), SAGA, plan I/O |
| `packages/typescript-config` | this file | Shared TS presets only — no business logic |
| `modules/<name>` | `docs/PHILOSOPHY.md`, `docs/MODULES.md` | Per-action layout, manifest, templates, validators |

## Build, test, and verify

```bash
pnpm install                # install workspace deps
pnpm check-types            # tsc --noEmit across all workspaces
pnpm test                   # vitest run in packages that have tests
pnpm build                  # turbo build
pnpm baka plan "<intent>"   # CLI (reads ${BAKA_HOME:-$HOME/.baka}/config.json — worker role)
pnpm baka module create <name>   # scaffold a new module
pnpm baka list-modules      # list discovered modules
pnpm mcp                    # run the baka-mcp server over stdio
```

## What an agent must NOT do

- Do not add a provider implementation outside `agent-engine/`. The grep test will fail.
- Do not import `@earendil-works/pi-coding-agent` (or any other provider runtime) outside `agent-engine/`.
- Do not introduce a separate credentials file, a `providers` map, an `activeProvider` marker, or a `defaults` block. Config is role-keyed: `${BAKA_HOME:-$HOME/.baka}/config.json` has top-level `worker` and `validator` blocks, apiKey inline. Edit a single field with `baka role <name> --field <k> --value <v>`.
- Do not write free-form code from an LLM. Every output must be a declared module action. If the action doesn't exist, the manifest catalog needs an entry first.
- Do not add "TODO" or "Phase N" placeholders that pretend to work. If a function cannot do its job, throw with a clear error pointing at the spec.
- Do not change the directory name `apps/cli/`. The binary is `baka`; the package is `baka`; the directory is `cli`.
- Do not make `apps/mcp/` depend on `apps/cli/`. Both apps are leaves that share `packages/*` and `workflows/*`. The MCP server does not shell out to the `baka` binary.
- Do not add a streamable HTTP transport, OAuth, or a multi-tenant auth layer to `apps/mcp/` until the requirement actually lands. The process rule in `docs/PHILOSOPHY.md` forbids building for a future state.
- Do not duplicate the `baka` MCP entry in your own user-level MCP config. The project-level `.mcp.json` already declares it; a duplicate adds no value. To disable it for yourself only, turn the project's entry off in your host's MCP UI.
