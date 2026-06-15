# Baka — Agent Guide

This document is the cross-package agent guide for the baka monorepo. It is the source of truth that package-level `AGENTS.md` files reference.

## Workspace layout

```
.
├── apps/cli/                # The baka binary (package name: baka)
│
├── workflows/               # Engine orchestration for THIS project
│   ├── feature-planning/    # Plan user intents into module actions
│   ├── module-management/   # Scaffold new modules
│   └── discovery/           # Walk modules/ and load manifests
│
├── packages/                # Engine tools (low-level nodes)
│   ├── protocol/            # SSOT: types, schemas, LLMProvider interface, exit codes
│   ├── agent-engine/        # The ONLY package that knows what an LLMProvider is
│   └── ast-tooling/         # File/AST operations, ModuleRegistry (Phase 3)
│
├── modules/                 # User-defined patterns (action-centric layout)
│
├── docs/                    # Philosophy, specs, agent guide
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
5. `apps/cli` is thin: command parsing, output formatting, dispatch to workflows.

**The grep test** that proves the provider boundary is intact:

```bash
grep -rE "fetch\(|https?://|api\.openai|anthropic" packages/ workflows/ apps/ --include="*.ts" | grep -v "agent-engine/"
```

This MUST return zero matches. If it doesn't, the boundary is leaking — file a regression and stop.

## Per-package pointers

| Package | Read first | Owns |
|---|---|---|
| `apps/cli` | this file, `docs/PHILOSOPHY.md` | CLI command surface, output formatting, exit codes |
| `workflows/feature-planning` | this file, `docs/PHILOSOPHY.md` | Orchestrator durable step + Worker loop |
| `workflows/module-management` | this file, `docs/PHILOSOPHY.md` | `baka scaffold` workflow |
| `workflows/discovery` | this file, `docs/PHILOSOPHY.md` | `discoverModules(rootDir)` + manifest validation |
| `packages/protocol` | this file, `docs/PHILOSOPHY.md` | All types, schemas, constants, exit codes, `LLMProvider` interface |
| `packages/agent-engine` | this file, `docs/PHILOSOPHY.md` | `createLLMProvider`, `loadLLMConfig`, `createOrchestratePlanningStep` |
| `packages/ast-tooling` | this file, `docs/PHILOSOPHY.md` | `executeAstTransformationStep`, future `ModuleRegistry` |
| `packages/typescript-config` | this file | Shared TS presets only — no business logic |
| `modules/<name>` | `docs/PHILOSOPHY.md`, `docs/MODULE-AUTHORING.md` (Phase 2) | Per-action layout, manifest, templates, validators |

## Build, test, and verify

```bash
pnpm install                # install workspace deps
pnpm check-types            # tsc --noEmit across all workspaces
pnpm test                   # vitest run in packages that have tests
pnpm build                  # turbo build
pnpm baka plan "<intent>"   # CLI (uses your BAKA_LLM_* env or user config)
pnpm baka scaffold <name>   # scaffold a new module
pnpm baka list-modules      # list discovered modules
```

## The 8 phases (and which package each phase changes)

| Phase | What lands | Packages touched |
|---|---|---|
| 1 — Foundation, sealed | types, schemas, CLI rename, philosophy doc | `protocol`, `agent-engine`, `apps/cli`, `docs/` |
| 2 — CLI-driven config + module authoring | `baka init`, `baka config`, `baka module *` | `apps/cli`, `agent-engine` (config loader) |
| 3 — Module registry + workers | real `ModuleRegistry`, real compensation | `ast-tooling`, `workflow-sdk` (new) |
| 4 — Orchestrator + Validator + LLM | `OpenAICompatibleProvider`, real `Validator` | `agent-engine`, `ast-tooling` |
| 5 — WorkflowSDK | `WorkflowEngine`, persistent state, logging | `packages/workflow-sdk` (new) |
| 6 — Real modules | `next-base`, `auth`, `ts-style`, `frontend-ui` | `modules/` |
| 7 — E2E CLI UX | `baka plan --dry-run`, `baka apply`, `baka validate` | `apps/cli`, all workflows |
| 8 — Tests + observability | compensation tests, E2E, structured logs | `packages/workflow-sdk`, `apps/cli` |

The current source of truth for each phase is `docs/superpowers/specs/2026-06-15-baka-redesign.md`. Per-phase spec docs land under `docs/superpowers/specs/` as each phase is started.

## What an agent must NOT do

- Do not add a provider implementation outside `agent-engine/`. The grep test will fail.
- Do not import `@earendil-works/pi-coding-agent` (or any other provider runtime) outside `agent-engine/`. The adapter is optional and lands in Phase 4.
- Do not introduce a config file users have to hand-edit. Config is CLI-driven (`baka config`).
- Do not write free-form code from an LLM. Every output must be a declared module action. If the action doesn't exist, the manifest catalog needs an entry first.
- Do not add "TODO" or "Phase N" placeholders that pretend to work. If a function cannot do its job, throw with a clear error pointing at the spec.
- Do not change the directory name `apps/cli/`. The binary is `baka`; the package is `baka`; the directory is `cli`.
