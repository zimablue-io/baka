# Project Memory

Short, hand-curated facts the model should keep in mind on every session.
Real rules live in `.factory/rules/`. This file is the index + project-specific
nuggets that don't deserve a full rule file.

Cross-project personal memory lives in `~/.factory/memories.md` and is
injected automatically on session start.

## Active Constraints

See `.factory/rules/` for the canonical rules. This file only adds
project-specific constraints that don't yet deserve a full rule file.

- All hooks in this repo are wired in `.factory/settings.json` and
  `~/.factory/settings.json` (user-level). Universal hooks (SessionStart,
  UserPromptSubmit, Stop) are inherited from user level via Factory's
  extension-only merge.

## Known Stale Knowledge

<!-- Add project-specific "training-data is wrong, the actual state is X"
     entries here. -->

## Past Decisions

<!-- Capture the WHY of non-obvious decisions here. -->
