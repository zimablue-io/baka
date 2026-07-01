
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

# baka

Baka is a deterministic orchestration engine for LLM-assisted development. The LLM cannot invent code, files, or structure — it picks from a finite, declared action space (the module catalog). The same intent + the same modules always produce the same plan.

## Install

Baka ships as two binaries: the `baka` CLI and the `baka-mcp` MCP server. They are independent (you can use either or both), share the same engine, and are installed together.

### Prerequisites

- **Node.js 20 or later** (the engine floor). `node --version` should print `v20.x` or higher.
- **pnpm 8 or later** (the workspace manager). The repo pins `pnpm@9.0.0` via `packageManager`.

Verify both are present before installing:

```bash
node --version   # v20.x or higher
pnpm --version   # 8.x or higher (9.x recommended)
```

### One-command install

From a fresh clone of this repository:

```bash
git clone https://github.com/zimablue/baka.git
cd baka
pnpm install
pnpm link:global
```

`pnpm link:global` runs the canonical per-workspace pattern
(`pnpm --filter baka --filter @baka/mcp-server exec pnpm link --global`)
and puts both `baka` and `baka-mcp` on your `PATH`. This form works
under pnpm 9 and pnpm 10 (bare `pnpm link --global` from the repo
root can be a silent no-op when the workspace is registered as
`private: true`; the per-workspace `exec` form is the one that
actually publishes the bin shim). Verify:

```bash
which baka       # -> a symlink under the pnpm global bin dir
which baka-mcp   # -> a symlink under the pnpm global bin dir
baka --version   # prints 0.1.0
```

The link is idempotent: re-running `pnpm link:global` is a no-op. `pnpm install` is also idempotent (the repo's `postinstall` hook rebuilds the CLI on every install, so the symlink target always exists).

### Installing from a tarball

If you have a built tarball (e.g. from `dist-tarballs/baka-0.1.0.tgz` and `dist-tarballs/@baka-mcp-server-0.1.0.tgz`) and you do not want to clone the repo:

```bash
pnpm install -g ./baka-0.1.0.tgz ./@baka-mcp-server-0.1.0.tgz
which baka
which baka-mcp
```

Tarballs are produced by `scripts/release.sh` (see [Publishing](./docs/PUBLISHING.md) for the canonical release flow).

### After install

Add the baka MCP server to your user-level Factory config (`~/.factory/mcp.json`) so it attaches in every session. If you already have entries under `mcpServers` (supabase, sanity, context7, etc.), merge this `baka` entry into your existing `mcpServers` block. Do NOT replace the whole file; your other servers and the `persistentPermissions` block must be preserved verbatim.

The baka entry (exact, copy-paste-ready):

```json
"baka": {
  "type": "stdio",
  "command": "baka-mcp",
  "args": [],
  "disabled": false,
  "timeoutMs": 120000
}
```

For a fresh config with no existing entries, the full file is:

```json
{
  "mcpServers": {
    "baka": {
      "type": "stdio",
      "command": "baka-mcp",
      "args": [],
      "disabled": false,
      "timeoutMs": 120000
    }
  }
}
```

> **Do NOT touch `persistentPermissions`.** Factory uses that block to remember which MCP servers and tools you have approved. Modifying it (or losing it during a copy-paste) causes unexpected re-prompts and approval loss.

That single `baka` entry is enough to make `baka_plan`, `baka_apply`, `baka_validate`, and `baka_list_actions` available in every coding-agent session, regardless of the working directory. Project-level `.factory/mcp.json` overrides this entry on a per-key conflict (e.g. a sibling project's local config wins when opened).

## Quickstart

After install, the canonical first-run sequence is:

```bash
# 1. Configure an LLM provider (interactive; runs once per machine).
baka init

# 2. Discover what baka can do in the current project.
baka list-modules
# Found 3 module(s):
#   baka-base (3 actions): scaffold, add-script, add-dependency
#   sdd (2 actions): init-constitution, create-feature
#   ts-style (2 actions): install-config, lint

# 3. Plan a feature. The LLM picks from the discovered module catalog.
baka plan "scaffold a TypeScript project with biome + vitest"

# Same call, machine-readable (mirrors the MCP tool shape):
baka plan "scaffold a TypeScript project" --json
```

Every command accepts `--json` and emits the same shape as the corresponding MCP tool. Use `--json` from CI, scripts, and pipes; the human-readable default is for the terminal.

## Uninstall

```bash
pnpm unlink --global baka @baka/mcp-server
which baka       # empty
which baka-mcp   # empty
```

The `pnpm unlink` step is enough on most pnpm versions. If the shims persist (pnpm version drift between content-addressable stores), `scripts/unlink-global.sh` falls back from `pnpm uninstall -g` to deleting the shim files directly. It is idempotent and safe to re-run.

```bash
scripts/unlink-global.sh            # removes both
scripts/unlink-global.sh baka       # removes only the CLI
```

To reinstall after uninstall:

```bash
pnpm install
pnpm link:global
```

## Troubleshooting

### `command not found: baka` after install

The pnpm global bin directory is not on `PATH`. pnpm prints its location after `pnpm link --global`:

```bash
pnpm link --global
# ... look for: "You can now run: baka / baka-mcp"
```

Add that directory to your shell `PATH`. On macOS with Homebrew pnpm it is typically `~/Library/pnpm`; with corepack it is `~/.local/share/pnpm`. Persist it by adding a line to `~/.zshrc` or `~/.bashrc`:

```bash
export PATH="$HOME/Library/pnpm:$PATH"
```

Verify the recovery:

```bash
command -v baka   # exits 0 with a path; exits 1 if missing
baka --version    # works once PATH is fixed
```

### `baka plan` fails with "missing LLM config: worker role not configured"

Run `baka init` to configure both LLM roles (worker + validator). The engine calls the worker-role model directly for plan / apply / module-design and the validator-role model for semantic validators; both blocks live in the same file at `~/.baka/config.json`. Refuses to plan or apply until the worker role is configured. Quick check:

```bash
baka roles             # shows every role's fields (apiKey masked as <set>)
baka init              # interactive: configure worker + validator
baka role worker --field model --value gemma4:12b   # non-interactive field edit
```

For CI or headless environments, write `~/.baka/config.json` with the role-keyed shape (`{ worker: {...}, validator: {...} }`) before running baka. apiKey lives inline in each role's block; there is no separate credentials file.

### Broken barrel / import-time crash in one subcommand

Baka's CLI lazy-loads every subcommand action via dynamic `import()`. A bad import in one subcommand (e.g. a typo in a barrel re-export) must NOT crash the others. If a sibling subcommand still crashes:

1. Identify the failing subcommand: run each sibling (`baka --help`, `baka list-modules --json`, `baka plan --help`, `baka roles`, `baka init --help`) and see which one errors.
2. Open the failing barrel (usually `workflows/<name>/src/index.ts` or `apps/cli/src/commands/<name>/index.ts`) and check the re-exports. The canonical fix for the historic `workflows/module-management/src/index.ts` bug was adding the explicit `.ts` extension to the re-export target.
3. Rebuild: `pnpm build`. The lazy-load invariant is preserved by `tsup` (dynamic imports survive bundling).
4. If a subcommand still fails on import, report it as a regression — the engine should isolate the failure, not propagate it.

The CI smoke step (`pnpm --filter baka build` + `baka --version` + JSON-RPC `initialize`) catches the obvious barrel bugs before they reach `main`.

## Usage

### For coding agents (Claude Code, Cursor, Codex, Cline, Zed, etc.)

The project ships an MCP config at `.factory/mcp.json` that registers `baka-mcp` over stdio. Droid loads it automatically on session start — no `droid mcp add` needed. To add or remove MCP servers for the team, edit that file and commit the change. The `baka-mcp` binary resolves its working directory from `process.cwd()` at startup, so opening a Droid session anywhere in the repo will discover the project's modules and validators.

For other MCP-aware hosts (Claude Code, Cursor, Codex, Zed, etc.) configure the server with:

```json
{ "command": "baka-mcp" }
```

Once connected, the agent sees one MCP tool per declared action plus `baka_plan`, `baka_apply`, `baka_validate`, and `baka_list_actions`. See `SKILL.md` at the repo root for the full contract.

### For humans and shell scripts

To trigger workflows interactively, use the CLI:

```bash
# Plan a new feature
pnpm baka plan "<intent>"

# Plan with machine-readable output (for piping into jq)
pnpm baka plan "<intent>" --json

# Scaffold a new module
pnpm baka scaffold "<module_name>"
```

The CLI and the MCP server share the same engine: same workflows, same validators, same plan schema. `--json` flags on the CLI emit the same shape the MCP tools return.

#### CLI Alias
Add this to your `.bashrc` or `.zshrc` for quick access:

```bash
alias baka='pnpm --prefix . baka --'
```

### Creating a Test Module
To verify the engine, create a test module:
```bash
baka scaffold test-module
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
│   ├── module-management/
│   │   └── create-module.ts
│   └── discovery/
├── packages/                # Engine tools
│   ├── protocol/            # SSOT: types, schemas, LLMProvider interface
│   ├── agent-engine/        # The ONLY package that knows what an LLMProvider is
│   └── ast-tooling/         # File/AST operations, module registry
├── modules/                 # User-defined patterns (action-centric layout)
│   └── README.md
├── SKILL.md                 # Declarative agent contract (Claude Code, Codex, Cursor, etc.)
├── docs/                    # Philosophy, agent guide, specs
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## Multi-Agent Architecture Specification (AGENTS.md)
This document defines the roles, bounded actions, stream constraints, and validation boundaries of the intelligent routing plane. See `docs/PHILOSOPHY.md` for the locked-in design philosophy.

## Agent System Overview
The system operates on an isolated, deterministic execution loop. Agents do not write free-form code into user workspaces. Instead, they act as state-transition functions that parse user intent, match it against static structural schemas inside the modules/ folder, and return precise, validated JSON execution blocks.

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
1. **Orchestrator** (LLM) — high-reasoning planning. Receives user intent + the module manifest catalog. Emits a validated sequence of `{module, action, params}` steps. Cannot invent modules or actions; the catalog is the only allowed source.
2. **Worker** (dumb automation by default) — executes one declared action. When the action's manifest sets `requiresReasoning: true`, a small-LLM assist is invoked using the action's `templates/*.hbs` rendered with the action's params. The output of the LLM assist is the body of an explicitly-typed file or block defined by the module.
3. **Validator** (deterministic TypeScript) — runs the module's `validators/*.ts` and `_shared/validators/*.ts` functions against the resulting file tree. No LLM is involved. Returns `Pass` or `Fail(diff[])` with structured diagnostics.

## Provider Boundary
All provider knowledge (HTTP clients, API keys, model names) is sealed inside `packages/agent-engine/`. Workflows, the CLI, and `ast-tooling` only ever import the `LLMProvider` interface from `packages/protocol/`. The user picks the provider (llama.cpp, Ollama, vLLM, OpenAI, anything speaking the OpenAI chat-completions API) via `baka init`; the engine never dictates it.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contribution guide. CI must be green before merge: lint, type-check, test, build, pack, and the smoke step (linked-binary probe of `baka` and `baka-mcp`) all run on every PR. A failing CI run blocks merge — do not bypass the required status checks or push commits that skip the workflow.

## Release

To cut a new version, run `scripts/release.sh <semver>` from a clean tree. The script bumps the version in `package.json`, `apps/cli/package.json`, and `apps/mcp/package.json` consistently; runs `pnpm pack` for both workspaces; and prints the global-install command. It refuses to run on a dirty tree and supports `--dry-run` for plan-only output. The script does not push to npm — the publish step is a separate manual flow documented in [docs/PUBLISHING.md](./docs/PUBLISHING.md).

## License

[MIT](./LICENSE) — Copyright (c) 2026 zima blue ([zimablue.io](https://zimablue.io)).