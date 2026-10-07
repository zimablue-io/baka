# AGENTS.md

Project-level agent guide. This repo is harness-agnostic: everything an
agent needs lives in `.agents/` (rules + project memory) or `docs/`.

| Path | Holds |
|------|-------|
| `.agents/rules/` | Coding rules. See `.agents/README.md` for the index. |
| `.agents/memories.md` | Project-specific constraints and past decisions. |
| `docs/` | Human-facing docs: philosophy, module format, research. |
| `.mcp.json` | MCP server registration (`baka`), read by MCP-aware hosts. |

## Proactive Memory Capture

The agent drives capture proactively. It must:

1. After any rule violation (e.g. re-introducing a forbidden pattern,
   reverting a refactor) — write a dated note to `.agents/memories.md`
   under `## Active Constraints`.

2. After a non-obvious WHY surfaces in conversation (e.g. a design
   decision explained) — write a dated note to `.agents/memories.md`
   under `## Past Decisions`.

3. After discovering the user repeatedly has to correct the same thing —
   promote it to a rule under `.agents/rules/<name>.md`.

Frustration is the FAILURE signal, not the trigger: capture during the
session, not after the user complains.
