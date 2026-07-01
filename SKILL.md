---
name: baka
description: Deterministic module-action engine. Use to plan, scaffold, validate, and apply coding-agent work via a finite declared action space. The LLM picks from declared actions, never invents.
---

# baka

Baka is a deterministic orchestration engine for LLM-assisted development. The LLM cannot invent code, files, or structure — it picks from a finite, declared action space (the module catalog). The same intent + the same modules always produce the same plan.

Use baka when:
- The user asks to "plan a feature", "scaffold a module", "validate patterns".
- A coding task fits a known module action (auth, frontend-ui, ts-style, etc.).
- The user wants the LLM constrained, not creative.

Do NOT use baka for:
- Free-form coding tasks with no module in scope.
- Tasks where the user explicitly wants the model to invent (e.g. "design a brand new framework").

# Two ways to consume baka

## 1. The MCP server (preferred)

If your host supports MCP, configure it to spawn `baka-mcp` over stdio. The server exposes:

- **Tools** (one per declared action plus four workflow tools): `baka_plan`, `baka_apply`, `baka_validate`, `baka_list_actions`, and `baka_<module>_<action>` for every action in the catalog.
- **Resources**: `baka://modules` (directory), `baka://module/<name>/manifest` (full manifest).
- **Prompts**: `baka_design_module` (the double-diamond design flow).

Host configuration (one line):

```json
{
  "command": "baka-mcp"
}
```

For per-host setup: `claude mcp add baka -- baka-mcp` (Claude Code), or the equivalent for Cursor, Codex, Cline, Zed, OpenCode, Gemini CLI.

## 2. The CLI (no MCP)

The CLI works in any host with a Bash tool. Use `--json` to get machine-readable output that mirrors the MCP tool results.

```bash
# Discover what's available
baka list-modules --json

# Plan a feature
baka plan "set up a Next.js app with auth" --json

# Save the plan, then apply it
baka plan "set up a Next.js app with auth" --save
baka apply .baka/plans/<id>.plan.json --json

# Validate the project against module patterns
baka validate --json

# Validate a single module
baka module validate <name> --json

# Drive the double-diamond design flow interactively
baka module create <name>
```

# Workflow

1. **Discover**: call `baka list-modules --json` (or read `baka://modules`) to see the action catalog. The LLM is constrained to these.
2. **Plan**: call `baka plan "<intent>" --json` to get a Zod-validated plan. Each step is `{module, action, params}`. The plan is the source of truth; you cannot invent steps.
3. **Apply** (optional): save the plan with `--save` and run `baka apply <plan-file> --json`. The SAGA runs steps with compensation on failure; validators run after.
4. **Validate**: `baka validate --json` returns pass/fail with structured diagnostics.

# Module authoring

To design a new module, drive the double-diamond flow:

```bash
baka module create <name>
```

This runs an interactive REPL through four phases (Discover → Define → Develop → Deliver) and writes the manifest, actions, validators, templates, and a PREFERENCES.md into `modules/<name>/`. The same intent + the same catalog must always produce the same plan — the design tool enforces this with a 5x consistency test before delivery.

# Role configuration

The engine calls the LLM directly. Every call picks one role's model from `~/.baka/config.json`: the **worker** role drives plan/apply/module-design, the **validator** role drives module validators that need a semantic review. Both roles live in the same file as inline apiKey — no separate credentials file, no provider alias, no active marker. Configure each role once per machine:

```bash
baka init
```

`baka init` writes the role-keyed config (`{ worker: {...}, validator: {...} }`) to `~/.baka/config.json`. Edit a single field with `baka role <worker|validator> --field <name> --value <value>`. `baka-mcp` reads the same config at startup. Each role's model is its own choice; a small validator model and a large planner model are both fine.

# Invariants

- The LLM cannot invent code, files, or structure. It picks from the catalog.
- The same intent + the same modules always produce the same plan.
- Validators are pure TypeScript by default. A validator MAY opt into the validator-role LLM for a semantic review, but every structural check (file existence, placeholder detection, heading presence) runs without the LLM.
- All model knowledge is sealed inside `packages/agent-engine/`. The CLI, `baka-mcp`, and the workflows only import the `LLMProvider` interface from `packages/protocol`.
