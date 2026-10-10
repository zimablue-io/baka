# baka

Baka writes files from templates. A **recipe** is a named thing you run again and again (`baka run add-readme`): its files come from templates, so the same call writes the same bytes every time. Where a template leaves a gap, a **slot**, you fill it yourself or a model does. Nothing else is left to chance.

## Install

```bash
curl -fsSL https://github.com/zimablue-io/baka/releases/latest/download/install.sh | sh
```

That needs Node.js 20 or later and nothing else: no clone, no build, no link. It ends by asking the new install for its version, so you know it answers. To install a build you made yourself, `sh install.sh --tarball ./dist-tarballs/baka-0.1.0.tgz`; add `--prefix DIR` to keep it out of your global npm directory. The same tarball installs with `npm install --global <tarball>`.

## First run

No model, no account and no setup are needed:

```bash
mkdir my-app && cd my-app
baka run add-readme --name my-app      # writes README.md
baka list-packs                        # the recipes you can run
baka inspect add-readme                # its params, its slots and its templates
```

`add-readme` is a recipe of the `starter` pack, the one pack that ships inside every install: a README, a `.gitignore`, a license, an editorconfig, CI, a TypeScript library skeleton. Packs you install or write take over when they share a name, and `baka run <pack>/<recipe>` names one exactly. Everything is in [docs/PACKS.md](./docs/PACKS.md).

### Slots: you or a model

A recipe whose templates have slots stops and tells you what is open, and writes nothing:

```bash
$ baka run write --title Probe
baka: these slots need a value; pass each one and run again:
  --slot line=<value>   (prose) one sentence about the topic
  or give a model: --llm-base-url <url> --llm-model <name> [--llm-api-key-env <VAR>]
```

Fill them yourself, from a file, or hand the call a model; none of it is remembered between calls:

```bash
baka run write --title Probe --slot "line=A short note."
baka run write --title Probe --slots-file slots.json
baka run write --title Probe --llm-base-url http://localhost:11434/v1 --llm-model qwen3
```

`baka init` stores a model for everyday use. It is optional.

### From a script, an agent or another product

Every command takes `--json` and prints a versioned document; errors are `{ "error": { "code", "message", "hint" } }`; exit codes mean the same thing everywhere (`0` done, `1` ran and failed, `2` bad input, `3` not available or incompatible). `--isolated` (or `BAKA_ISOLATED=1`) makes a call depend only on its flags, its environment and its project, never on what is in `~/.baka`. `baka version --json` is the handshake a host runs first. All of it is written down, with the schemas, in [docs/CONTRACT.md](./docs/CONTRACT.md).

## Install from a clone (contributors)

Prerequisites:

- **Node.js 20 or later** (the engine floor). `node --version` should print `v20.x` or higher.
- **pnpm 8 or later** (the workspace manager). The repo pins `pnpm@9.0.0` via `packageManager`.

Verify both are present before installing:

```bash
node --version   # v20.x or higher
pnpm --version   # 8.x or higher (9.x recommended)
```

**Link the checkout:**

From a fresh clone of this repository:

```bash
git clone https://github.com/zimablue-io/baka.git
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

**Install from tarballs you built:**

If you have a built tarball (e.g. from `dist-tarballs/baka-0.1.0.tgz` and `dist-tarballs/@baka-mcp-server-0.1.0.tgz`) and you do not want to clone the repo:

```bash
pnpm install -g ./baka-0.1.0.tgz ./@baka-mcp-server-0.1.0.tgz
which baka
which baka-mcp
```

Tarballs are produced by `scripts/release.sh` (see [Publishing](./docs/PUBLISHING.md) for the canonical release flow).

## Add the MCP server to a coding agent

Add the baka MCP server to your user-level MCP config so it attaches in every session. If you already have entries under `mcpServers` (supabase, sanity, context7, etc.), merge this `baka` entry into your existing `mcpServers` block. Do NOT replace the whole file; your other servers must be preserved verbatim.

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

That single `baka` entry is enough to make `baka_plan`, `baka_apply`, `baka_validate`, and `baka_list_recipes` available in every coding-agent session, regardless of the working directory. The repo also ships a project-level `.mcp.json`, which MCP-aware hosts read automatically when you open the repo.

## Quickstart

The everyday commands, after the install above:

```bash
baka list-packs --json                       # what can be run here
baka run <recipe> --json                     # run it (pack/recipe when two packs share a name)
baka slots <recipe> --json                   # the slots it leaves open
baka fill  <recipe> --slot <id> --value "..." --json   # pin one fill in the project's slot cache

# Fuzzy catalog picker (demoted; not the product path; needs a stored model):
baka plan "scaffold a TypeScript project with biome + vitest"
```

Every command accepts `--json` and emits the same shape as the corresponding MCP tool. Use `--json` from CI, scripts, and pipes; the human-readable default is for the terminal.

### Serving the engine over HTTP

`baka serve` exposes the same engine the CLI and `baka-mcp` use (`GET /v1/packs`, `POST /v1/run`, `/v1/fill`, `/v1/validate`, ...) as JSON over HTTP, for a host that has the project's files on disk. It is a code-writing service, so it is closed by default:

```bash
baka serve                                  # 127.0.0.1:4311, bound to this project (the cwd), no auth needed
BAKA_ENGINE_TOKEN=$(openssl rand -hex 24) baka serve --host 0.0.0.0   # reachable from other machines: token required
```

- **Bearer token.** With `BAKA_ENGINE_TOKEN` (or `--token`, which shows up in `ps`; the env var is preferred) set, every request needs `Authorization: Bearer <token>` and gets `401` otherwise. The token must not contain whitespace. `baka serve` refuses to start on any bind address that is not loopback (`127.0.0.0/8`, `::1`, `localhost`) unless a token is set.
- **Project paths.** A request may name a `project` (query string or body field) only when it is the directory the server was started in, or when the server was started with allowed roots: `--allow-root <dir>` (repeatable) or `BAKA_ENGINE_ALLOWED_ROOTS` (separated like `PATH`). A `project` must be an absolute path to an existing directory; symlinks are resolved before the check, so a link inside a root cannot lead out of it. Anything else is `403`, and nothing is read or written there.
- The run, fill, and validate routes return the same JSON as `baka run|fill|validate --json` and the `baka_*` MCP tools; `/v1/run` takes `dryRun`, `slots`, `onExisting`, `includeContent`, and `validate` alongside `pack`, `recipe`, and `params`.

### Verifying determinism

The same-tree claim is enforced two ways. CI uses a recorded slot cache and asserts byte-identical output with no llama. An opt-in live e2e (`apps/cli/test/determinism-e2e.test.ts`) hashes apply output against local llama-server (`gemma4:e4b`, temperature 0, seed 42). Run the live suite with:

```bash
BAKA_E2E_LLM=1 pnpm --filter baka exec vitest run test/determinism-e2e.test.ts
```

The e2e only ever sends requests; it never starts, restarts, or kills the llama-server. The fixed seed is a normal role-config field: set it with `baka role worker --field seed --value 42` (or hand-edit `${BAKA_HOME:-$HOME/.baka}/config.json`).

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

Run `baka init` to configure both LLM roles (worker + validator). The engine calls the worker-role model directly for plan / apply / pack-design and the validator-role model for semantic validators; both blocks live in the same file at `${BAKA_HOME:-$HOME/.baka}/config.json`. Refuses to plan or apply until the worker role is configured. Quick check:

```bash
baka roles             # shows every role's fields (apiKey masked as <set>)
baka init              # interactive: configure worker + validator
baka role worker --field model --value gemma4:12b   # non-interactive field edit
```

For CI or headless environments, write `${BAKA_HOME:-$HOME/.baka}/config.json` with the role-keyed shape (`{ worker: {...}, validator: {...} }`) before running baka. apiKey lives inline in each role's block; there is no separate credentials file. Setting `BAKA_HOME` relocates the user-level directory (config, user marketplace, logs); `$HOME/.baka` is the default.

### Broken barrel / import-time crash in one subcommand

Baka's CLI lazy-loads every subcommand recipe via dynamic `import()`. A bad import in one subcommand (e.g. a typo in a barrel re-export) must NOT crash the others. If a sibling subcommand still crashes:

1. Identify the failing subcommand: run each sibling (`baka --help`, `baka list-packs --json`, `baka plan --help`, `baka roles`, `baka init --help`) and see which one errors.
2. Open the failing barrel (usually `workflows/<name>/src/index.ts` or `apps/cli/src/commands/<name>/index.ts`) and check the re-exports. The canonical fix for the historic `workflows/pack-management/src/index.ts` bug was adding the explicit `.ts` extension to the re-export target.
3. Rebuild: `pnpm build`. The lazy-load invariant is preserved by `tsup` (dynamic imports survive bundling).
4. If a subcommand still fails on import, report it as a regression — the engine should isolate the failure, not propagate it.

The CI smoke step (`pnpm --filter baka build` + `baka --version` + JSON-RPC `initialize`) catches the obvious barrel bugs before they reach `main`.

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

# Scaffold a new pack (chat-driven design flow)
pnpm baka pack create "<pack_name>"
```

The CLI and the MCP server share the same engine: same workflows, same validators, same plan schema. `--json` flags on the CLI emit the same shape the MCP tools return.

#### CLI Alias
Add this to your `.bashrc` or `.zshrc` for quick access:

```bash
alias baka='pnpm --prefix . baka --'
```

### Creating a Test Pack
To verify the engine, create a test pack:
```bash
baka pack create test-pack
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
│   ├── mcp/                 # The baka-mcp binary (MCP server over stdio for coding agents)
│   ├── api/                 # The marketplace catalog API (read routes over hand-maintained data)
│   └── landing/             # The landing site (pack catalog pages)
├── workflows/               # Engine orchestration for THIS project
│   ├── feature-planning/    # Plan user intents into pack recipes
│   └── pack-management/   # Scaffold new packs
├── packages/                # Engine tools
│   ├── protocol/            # SSOT: types, schemas, LLMProvider interface
│   ├── agent-engine/        # The ONLY package that knows what an LLMProvider is
│   ├── core/                # @baka/core: the published, embeddable library surface (no CLI, no ~/.baka)
│   ├── ast-tooling/         # File/AST operations, PackRegistry (pack discovery)
│   ├── baka-sdk/            # The public boundary pack authors import from
│   └── typescript-config/   # Shared TS presets
├── packs/                 # Empty on purpose. Packs live in a project, not here.
├── scripts/                 # pack.mjs, release.sh, setup.sh, unlink-global.sh
├── dist-tarballs/           # Output of `pnpm pack` (baka + baka-mcp tarballs)
├── SKILL.md                 # Declarative agent contract (Claude Code, Codex, Cursor, etc.)
├── docs/                    # Philosophy, agent guide, pack authoring, publishing
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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contribution guide. CI must be green before merge: lint, type-check, test, build, pack, and the smoke step (linked-binary probe of `baka` and `baka-mcp`) all run on every PR. A failing CI run blocks merge — do not bypass the required status checks or push commits that skip the workflow.

## Release

To cut a new version, run `scripts/release.sh <semver>` from a clean tree. The script bumps the version in `package.json`, `apps/cli/package.json`, and `apps/mcp/package.json` consistently; runs `pnpm pack` for both workspaces; and prints the global-install command. It refuses to run on a dirty tree and supports `--dry-run` for plan-only output. The script does not push to npm — the publish step is a separate manual flow documented in [docs/PUBLISHING.md](./docs/PUBLISHING.md).

## License, paid options and privacy

Baka is open source under the [Apache License 2.0](./LICENSE) ([NOTICE](./NOTICE)): use it, embed it, fork it, sell what you build on it. Everything in this repository is free and complete, with no account. The owner also offers paid options built around it, a private pack registry and team features among them; they are listed in [COMMERCIAL.md](./COMMERCIAL.md) and live outside this repository. The name and logos are reserved ([TRADEMARKS.md](./TRADEMARKS.md)); outside contributions come under the agreement in [CONTRIBUTING.md](./CONTRIBUTING.md).

**No telemetry, no phoning home.** Nothing in the open code sends usage data, checks for updates or contacts a server on its own. The code makes a network connection only when you ask it to: a model endpoint you name for slots, a registry or git/npm source you name for `baka install`, `search` or `publish`. `apps/cli/test/first-run.test.ts` runs `version`, `health`, `list-packs`, `inspect` and `run` with every socket, name lookup and `fetch` traced and fails on any.

A paid add-on attaches through one documented extension point (`--addon`, see [docs/CONTRACT.md](./docs/CONTRACT.md)); the open tool contains no license checks.

Copyright 2026 zima blue ([zimablue.io](https://zimablue.io)).