
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

## Usage

### For coding agents (Claude Code, Cursor, Codex, Cline, Zed, etc.)

The project ships an MCP config at `.mcp.json` that registers `baka-mcp` over stdio. MCP-aware hosts read it automatically on session start. To add or remove MCP servers for the team, edit that file and commit the change. The `baka-mcp` binary resolves its working directory from `process.cwd()` at startup, so opening a session anywhere in the repo will discover the project's packs and validators.

For other MCP-aware hosts (Claude Code, Cursor, Codex, Zed, etc.) configure the server with:

```json
{ "command": "baka-mcp" }
```

Once connected, the agent sees one MCP tool per declared recipe plus `baka_plan`, `baka_apply`, `baka_validate`, and `baka_list_recipes`. See `SKILL.md` at the repo root for the full contract.

### For humans and shell scripts

To trigger workflows interactively, use the CLI:

```bash
# Plan a new feature
pnpm baka plan "<intent>"

# Plan with machine-readable output (for piping into jq)
pnpm baka plan "<intent>" --json

# Scaffold a new pack
pnpm baka scaffold "<pack_name>"
```

#### Where packs come from

Without configuration the CLI discovers packs in the project's `packs/` and `.baka/packs` and in the user marketplace. To pin a project to one catalog (so a bare `baka validate` gives the same answer on every machine), list its directories in `.baka/settings.json`:

```json
{ "packDirs": ["../baka-packs/packs"] }
```

Relative entries resolve against the project root (`--cwd`); when the setting is present only those directories are searched. `BAKA_PACK_DIRS` overrides it and `--packs-dir <path>` (repeatable) overrides both. A listed directory that does not exist is an error that names the file, the entry and the fix. See `docs/PACKS.md`.

The CLI and the MCP server share the same engine: same workflows, same validators, same plan schema. `--json` flags on the CLI emit the same shape the MCP tools return.

#### CLI Alias
Add this to your `.bashrc` or `.zshrc` for quick access:

```bash
alias baka='pnpm --prefix . baka --'
```

### Creating a Test Pack
To verify the engine, create a test pack:
```bash
baka scaffold test-pack
```

## Technical Specifications
- Monorepo Engine: Turborepo managed with strict pnpm workspaces.
- Runtime Dependency: Node.js (v20+) or Bun running entirely via native local script invocation.
- Target Core Stack: TypeScript, Next.js v16, Turborepo, Shadcn UI + Radix Base UI, Tailwind CSS.
- Target Domain Additions: Better-Auth, Neon DB, Supabase Storage, Sanity CMS.

## Directory Architecture
```
.
├── apps/
│   ├── cli/                 # The baka binary (user-facing CLI)
│   └── mcp/                 # The baka-mcp binary (MCP server over stdio for coding agents)
├── workflows/               # Engine orchestration for THIS project
│   ├── feature-planning/
│   │   └── plan-intent.ts
│   └── pack-management/
├── packages/                # Engine tools
│   ├── protocol/            # SSOT: types, schemas, LLMProvider interface
│   ├── agent-engine/        # The ONLY package that knows what an LLMProvider is
│   └── ast-tooling/         # File/AST operations, pack registry
├── packs/                 # User-defined patterns (recipe-centric layout)
│   └── README.md
├── SKILL.md                 # Declarative agent contract (Claude Code, Codex, Cursor, etc.)
├── docs/                    # Philosophy, agent guide, specs
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## Multi-Agent Architecture Specification (AGENTS.md)
This document defines the roles, bounded recipes, stream constraints, and validation boundaries of the intelligent routing plane. See `docs/PHILOSOPHY.md` for the locked-in design philosophy.

## Agent System Overview
The system operates on an isolated, deterministic execution loop. Agents do not write free-form code into user workspaces. Instead, they act as state-transition functions that parse user intent, match it against static structural schemas inside the packs/ folder, and return precise, validated JSON execution blocks.

## The Agent Topology
```
                  +-----------------------+
                  |  Human Prompt Input   |
                  +-----------+-----------+
                              |
                              v
                  +-----------------------+
                  |  Orchestrator (LLM)   |
                  +-----------+-----------+
                              |
            +-----------------+-----------------+
            |                                   |
            v                                   v
+-----------------------+           +-----------------------+
|  Worker (dumb auto)   |           |  Validator (TS rules) |
|  (small LLM when      |           |  (deterministic, no   |
|   requiresReasoning)  |           |   LLM in hot path)    |
+-----------------------+           +-----------------------+
```

## Tier Rules
1. **Orchestrator** (LLM) — high-reasoning planning. Receives user intent + the pack manifest catalog. Emits a validated sequence of `{pack, recipe, params}` steps. Cannot invent packs or recipes; the catalog is the only allowed source.
2. **Worker** (dumb automation by default) — executes one declared recipe. When the recipe's manifest sets `requiresReasoning: true`, a small-LLM assist is invoked using the recipe's `templates/*.hbs` rendered with the recipe's params. The output of the LLM assist is the body of an explicitly-typed file or block defined by the pack.
3. **Validator** (deterministic TypeScript) — runs the pack's `validators/*.ts` and `_shared/validators/*.ts` functions against the resulting file tree. No LLM is involved. Returns `Pass` or `Fail(diff[])` with structured diagnostics.

## Provider Boundary
All provider knowledge (HTTP clients, API keys, model names) is sealed inside `packages/agent-engine/`. Workflows, the CLI, and `ast-tooling` only ever import the `LLMProvider` interface from `packages/protocol/`. The user picks the provider (llama.cpp, Ollama, vLLM, OpenAI, anything speaking the OpenAI chat-completions API) via `baka init`; the engine never dictates it.

## License

[Apache-2.0](./LICENSE) — Copyright 2026 zima blue ([zimablue.io](https://zimablue.io)).