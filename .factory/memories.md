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

- **Port 8080 is the user's llama-server (off-limits).** AGENTS.md and
  `services.yaml` both call it out: never start, stop, kill, or check its
  presence/absence. Validators that look for orphan processes via `lsof -ti:8080`
  must NOT escalate to a `kill -9` against the resulting PID — that PID
  belongs to the user's shared llama-server. The only allowed read interaction
  is the healthcheck URL `curl -sf http://127.0.0.1:8080/v1/models`. Validators
  that find leftover fake-LLM helper servers (the 127.0.0.1:0 ephemeral ports
  ephemeral-bound, normal-close-on-handle) must use process-tree inspection
  (parent process, command name `node`, vs the launcher) to distinguish them
  from the shared llama-server which uses port 8080 statically. Recorded
  2026-08-06 after a user-testing-validator session mistakenly used
  `lsof -ti:8080` to find orphan processes and `kill -9`'d the user's
  llama-server. (Auto-restart may have recovered; not retested in this session.)

- **2026-08-06: Sequence edits to the same file.** A parallel tool batch may
  target each file at most once; dependent edits to one file run in separate
  batches so neither replacement races the other.

## Known Stale Knowledge

<!-- Add project-specific "training-data is wrong, the actual state is X"
     entries here. -->

## Past Decisions

<!-- Capture the WHY of non-obvious decisions here. -->

- 2026-08-06 user-testing-validator (foundation-fix milestone): the validator
  ran five parallel flow-validator subagents (a user-testing-flow-validator
  custom droid). Three returned "Subagent session reported an error" but
  actually wrote substantial evidence + flow JSONs to disk before erroring.
  Future validators should rely on the on-disk artifacts themselves, not
  on the harness's session-status, when partial work is acceptable — a
  session-error rcode does not imply zero work was produced.

