---
name: proactive-memory-capture
description: Use this skill when the agent notices a memory-worthy event during a session — before the user has to say "remember this" and before any frustration signal lands. Captures preferences, decisions, constraints, and stale-knowledge corrections into .factory/memories.md or ~/.factory/memories.md proactively.
---

# Proactive Memory Capture

The frustration-detect hook and the user's "remember this:" pattern
both fire *after* the moment of capture has passed. The user has
been clear: by the time a frustration signal lands, the proactive
moment is already gone. This skill is the agent's own decision to
write to memory when it observes something memory-worthy, without
waiting to be asked.

It is invoked by the agent itself, mid-session, when one of the
trigger conditions below applies. It is NOT a slash command, NOT a
hook, and the user does not invoke it.

## When to capture

Write to memory when ANY of these is true:

1. **Stable preference expressed.** The user says "I always…",
   "I never…", "from now on…", "stop doing…", or any phrasing
   that signals a stable personal rule.
2. **Non-obvious constraint surfaced.** Code, error, docs, or a
   test reveals a constraint that the model would otherwise have
   to rediscover every session (e.g. "the ORPC mount is at
   /rpc/[[...rest]]/route.ts, not under a separate API host").
3. **Recurring pattern identified.** The same correction, fix,
   or workaround has come up twice in the session, or twice
   across recent log entries.
4. **User correction on a knowable fact.** The user says the
   model got X wrong, and X is something the model should have
   known. (Distinct from "user corrected my code" — only capture
   when the correction is general, not project-specific.)
5. **Architectural decision made.** A choice was settled
   ("we're going with Zustand, not Redux", "the CLI returns
   undefined, never defaults"), and the decision is durable
   enough to outlive the session.
6. **Stale knowledge corrected.** The user corrected something
   the model thought it knew from training data (e.g. "no, the
   API SDK 7 renames `experimental_context`, SDK 6 still uses
   it"). Worth recording so the model does not regress.

## When NOT to capture

Do not write to memory when:

- Routine task progress (file edited, test ran, build passed).
- Anything already stated in `.factory/rules/*.md`. Rules are
  authoritative; memory should not duplicate them.
- One-off task-specific facts that won't recur.
- Anything project-specific that belongs in code, tests, or
  docs — not memory.
- The session itself is too short to validate the signal.

## Where to write

Two destinations, picked by scope:

### `.factory/memories.md` (project memory)

Curated. Limited to a few sections:

- `## Active Constraints` — non-rule project facts (e.g. hook
  wiring, file locations, mechanical invariants).
- `## Known Stale Knowledge` — corrections to training-data
  misconceptions that the model keeps making.
- `## Past Decisions` — settled architectural choices.

The file MUST stay small (target ≤ 8 KB, hard cap 12 KB). Before
appending, read the file. If appending would push it past the
hard cap, propose a prune first.

### `~/.factory/memories.md` (personal memory)

Cross-project preferences and personal coding style that should
follow the user across all repos. Sections the doc recommends:

- Communication style
- Tool preferences
- Coding philosophy
- React / Next.js preferences
- Workflow contract

## Format

For project memory:

```md
### YYYY-MM-DD — <one-line summary>

<1–3 lines of context that future agents need to know>
```

For personal memory:

```md
### YYYY-MM-DD — <preference area>

- <the preference>
- <why or when it applies>
```

Always include the date. Never write more than one short bullet
per capture. If a capture grows past three lines, it is probably
a rule and belongs in `.factory/rules/`.

## The proactive moment

The right moment to capture is *during the same turn* as the
event — not at session end, not in the reflection-loop skill.
If the model waits for the reflection-loop skill, the moment
has passed.

Capture right after responding to the user. Do not interrupt
the user's flow with "let me save that to memory." Just write it
in the same tool-call batch.

## Verification

After every capture, run:

```bash
just review-rules-coupling
```

to confirm the new entry did not introduce a rule/memory
coupling. This is the mechanical guard against accidentally
writing a rule that references memory.

## Related

- `.factory/skills/reflection-loop/SKILL.md` — fires at session
  end, after a frustration signal or observed violation; proposes
  rule updates. Different concern: this skill writes to memory;
  reflection-loop proposes rule promotions.
- `.factory/memories.md` — the curated project memory file.
- `~/.factory/memories.md` — the personal memory file.
- `.factory/scripts/check-rule-memory-coupling.py` — the
  mechanical guard against rule/memory coupling.
