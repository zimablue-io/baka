# AGENTS.md

Project-level agent guide. Universal rules live under `.factory/rules/`
and personal preferences live in `~/.factory/memories.md`.

(Personal Memory + Proactive Capture sections are appended by
`factory-bootstrap.py`.)

<!-- BEGIN:personal-memory-section -->

## Personal Memory

Personal preferences, capture philosophy, and coding style live in
`~/.factory/memories.md` (cross-project). It is injected automatically
on session start by `~/.factory/scripts/session-init.sh`. This file
holds ONLY project-specific facts.

<!-- END:personal-memory-section -->

<!-- BEGIN:proactive-capture-section -->

## Proactive Memory Capture

The agent drives capture proactively. It must:

1. After any rule violation (e.g., re-introducing a forbidden pattern,
   reverting a refactor) — write a dated note to `.factory/memories.md`
   under `## Active Constraints` and (if pattern) append to the rule's
   `### Observed (auto-logged)` section.

2. After a non-obvious WHY surfaces in conversation (e.g., a design
   decision explained) — write a dated note to `.factory/memories.md`
   under `## Past Decisions`.

3. After discovering the user repeatedly has to correct the same
   thing — promote it to a rule under `.factory/rules/<name>.md` and
   add the pattern to `rule-patterns.json` (run `just rules-compile`).

`/remember` and manual capture hooks are FORBIDDEN — by the time the
user thinks to trigger them, the moment has passed. Frustration
signals (`.factory/logs/frustration/`) are the FAILURE signal, not
the trigger.

<!-- END:proactive-capture-section -->
