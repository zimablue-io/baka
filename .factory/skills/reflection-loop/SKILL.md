---
name: reflection-loop
description: Use this skill at the end of any session that frustrated the user or got an architecture fact wrong. Walks through which rule was violated, why it didn't fire, and proposes an update to .factory/rules/ or .factory/memories.md.
---

# Reflection Loop

The automated hooks (`.factory/hooks/frustration-detect.sh`,
`.factory/hooks/reflect-session.sh`) gather evidence: a frustration
signal in the prompt, or an observed violation in the diff. They
append to `.factory/memories.md` and the matching rule file. They
do not generate new rules or sharpen existing ones.

This skill is where the model proposes the update. Use it at the end
of any session that:

- Triggered a frustration signal (`.factory/memories.md` has a new
  `## Frustration Signals` entry).
- Triggered an observed violation (`.factory/memories.md` has a new
  `## Observed Violations` entry, or a rule file has a new entry
  under `### Observed (auto-logged)`).
- Got a fact about the architecture wrong.

## The walkthrough

1. **Read the latest entries** in `.factory/memories.md` and the
   `### Observed (auto-logged)` sections of the rule files.
2. **For each entry, ask:**
   - Which rule did I violate, or which fact did I get wrong?
   - Is that rule already in `.factory/rules/`? If yes, why didn't
     it fire? Was the regex too narrow? Was the rule's prose too
     soft?
   - If it's a new pattern not yet in `.factory/rules/`, what's
     the principle? Write it in the same style as the existing
     rules: positive example, negative example, citations to
     upstream docs (Context7).
3. **Propose a patch.** The patch is a `git diff` against
   `.factory/rules/`, `.factory/memories.md`, or
   `.factory/rule-patterns.json`. Keep it focused: one rule per
   patch. Do not lump multiple updates into one.
4. **Do not apply the patch.** Show it to the user. The user
   approves, rejects, or amends.
5. **If the user approves**, apply the patch, run
   `just rules-compile` to regenerate `rule-patterns.json` from
   the per-file rule-patterns blocks, and commit the change.

## What this skill is not

- It is not an excuse to bypass the gates. The patch is a *new*
  rule, not a *replacement* for the rules you should have followed
  in the first place.
- It is not a retroactive rationalization. "I see now that the
  rule was unclear" is the right framing; "I see now that the
  rule didn't apply" is the wrong one.
- It is not a place to add exceptions for one-off cases. The
  rule-patterns engine supports `exclude_paths` for legitimate
  exclusions; use that, or open a new rule.

## Promoting observed hits to top-of-file rules

When a rule has accumulated several entries under
`### Observed (auto-logged)`, that is the signal to promote the
recurring pattern into a hard rule:

1. Open the rule file.
2. Look at the observed entries.
3. If they share a clear pattern, tighten the prose at the top
   of the file with a positive/negative example that captures
   the pattern.
4. Tighten the `diff_regex` so it catches the next occurrence.
5. Move the observed entries to a "Historical" subsection or
   delete them.

`just review-rules` is the human loop for this. Do not let
observed entries accumulate indefinitely; they are a signal, not
a log.

## Related

- `.factory/rules/evidence-first.md`
- `.factory/rules/tdd-mandatory.md`
- `.factory/skills/evidence-based-coding/SKILL.md`
- `.factory/hooks/frustration-detect.sh`
- `.factory/hooks/reflect-session.sh`
- `just review-rules`
