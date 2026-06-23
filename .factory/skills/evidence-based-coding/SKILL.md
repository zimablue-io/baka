---
name: evidence-based-coding
description: Use this skill before any code change. Enforces the evidence-first sequence: read AGENTS.md, grep/read the actual files, call context7 for current docs, state the causal chain, then write the failing test first.
---

# Evidence-Based Coding

When implementing any code change, follow this evidence-first sequence.
Refusal to follow it is itself a rule violation (see
`.factory/rules/evidence-first.md`).

## The sequence

1. **Read the relevant package's AGENTS.md and root AGENTS.md.** These
   contain the local conventions, the SSOT pointers, and the
   operating contract. If the package doesn't have an AGENTS.md,
   state that explicitly.
2. **Grep and Read the actual files the change will touch.** Cite
   `file:line` for every claim about the existing code. If a file
   you expected to find doesn't exist, say so.
3. **Call Context7 to verify current docs** for every external
   library involved (Next.js, React, oRPC, Vercel AI SDK, Drizzle,
   Zod, Biome, better-sqlite3, etc.). Use
   `mcp__context7__resolve-library-id` to find the library, then
   `mcp__context7__query-docs` to read the relevant pages. Cite
   the doc URL.
4. **Web-search ONLY if Context7 is silent or the package version
   in `package.json` / `pyproject.toml` is not covered.** Cite the
   source.
5. **State the causal chain.** "I will change X in file Y because Z
   happens; the root cause is W." This is the Root Cause Gate from
   the root AGENTS.md.
6. **Only then write code. TDD: failing test first.** Watch it fail
   for the right reason (the feature is missing, not a typo). Then
   write the minimal code. Watch it pass. Then refactor.
7. **Run lint + typecheck + relevant tests.** Show the output.

## Why this exists

- LLM training data is 12–24 months stale for fast-moving
  libraries. The most common way the model produces a bad
  recommendation is by trusting memory instead of fetching docs.
- The most common way the model produces a bad recommendation in a
  *specific* repo is by not reading the existing patterns in that
  repo. A pattern from another codebase is not a pattern in this
  one.
- Without a stated causal chain, fixes are patches over symptoms
  rather than root causes.

## When to skip the sequence

The sequence is not optional. The only legitimate skips are:

- The change is a one-line typo or rename and the file/line is
  obvious from the prompt.
- The change is generated code from a tool, not a human-authored
  change.
- The user explicitly exempts the change ("just do it, don't read
  docs").

In all three cases, state the exemption explicitly in the response.

## Common rationalizations to reject

- "Training data already covers this library." — It does not. Use
  Context7.
- "The code is simple." — Simple code still benefits from cited
  context, especially when the team has had to push back on
  recurring mistakes.
- "The user said it's obvious." — Obvious to the user is exactly
  what we have been getting wrong.
- "I'll add tests after." — Tests-after prove the code does what
  you wrote, not what is required.

## Related

- `.factory/rules/evidence-first.md`
- `.factory/rules/tdd-mandatory.md`
- `.factory/rules/tests-as-quality-gate.md`
- `.factory/skills/reflection-loop/SKILL.md`
