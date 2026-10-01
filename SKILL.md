---
name: baka
description: Deterministic module-action engine. Files are templates with named slots. A local gemma4:e4b fills holes; it never authors structure. Prefer the CLI with --json.
---

# baka

Baka makes LLMs stupid on purpose. Files are Handlebars templates. Params interpolate. Named `{{#slot}}` holes are the only LLM surface. The intelligence floor is `gemma4:e4b` on the user's laptop via llama.cpp.

Same command + same params + same slot cache → byte-identical tree.

Use baka when:
- The user asks to run a declared module action, fill slots, or validate a tree.
- A coding task fits a known module action.

Do NOT use baka for free-form invention. If a slot only works on a frontier model, the template is wrong.

# Preferred: CLI + Skill

Hosts already know how to run CLIs. `--json` composes. Do not prefer MCP.

```bash
# Discover
baka list-modules --json

# Product path: named action. --json prints the receipt: ok, diagnostics, changeset
# (path, op, contentHash), outputTreeHash, pins, slots, compensation. A run validates by
# default: ok is false when a validator reports an error; warnings are in diagnostics.
baka run <module>/<action> --json
baka run <module>/<action> --dry-run --json          # same receipt, writes nothing
baka run <module>/<action> --on-existing overwrite   # skip (default) | overwrite | fail
baka run <module>/<action> --no-validate             # skip validators (a run validates by default)
baka run <module>/<action> --slot-records receipt.json   # replay a stored receipt's slot fills, no model
baka slots <module>/<action> --json
baka fill  <module>/<action> --slot <id> --value "..." --json

# Pin module versions (then `baka run` refuses a module that changed)
baka lock

# Validate
baka validate --json
baka validate --module <name> --json

# Modules: project vs user vs registry account
baka install @scope/name          # project .baka/modules
baka install @scope/name --user   # $BAKA_HOME/modules
baka registry login
baka publish repo@tag --org slug
```

`baka plan` is a fuzzy catalog picker, not the product path. Prefer `baka run`.

# Optional: MCP adapter

If the host has no reliable shell, spawn `baka-mcp` over stdio. Tools: `baka_run`, `baka_slots`, `baka_fill`, `baka_validate`, `baka_list_actions`, plus read-only registry search. There are **no** per-action MCP tools. There is no install over MCP; tell the user to run `baka install`.

# Workflow

1. **Discover** `baka list-modules --json`.
2. **Run** `baka run <module>/<action> --json` with declared params.
3. **Fill** empty slots with `baka fill` or let the configured `gemma4:e4b` worker fill them (cached under `.baka/slots/`).
4. **Validate** `baka validate --json`. CLI exit 4 and `valid: false` mean the same failure.

# Module scopes

| Scope | Where | Precedence |
|---|---|---|
| project | `.baka/modules` | wins |
| tree | `modules/` | 2 |
| user | `$BAKA_HOME/modules` | 3 |
| bundled | shipped with baka | 4 |

Cloud/account = registry auth + `baka install` into project or `--user`.
