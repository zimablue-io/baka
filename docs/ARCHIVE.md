# Documentation Archive

This file tracks documents that were intentionally removed from the tree
in favor of canonical successors living under `specs/`. Each entry names
the archived document, its successor, and the reason for the archive.

## Archived: PRD and ROADMAP

**Date:** 2026-06-25

**Reason:** Content superseded by the `specs/` directory, which now
serves as the product's living documentation surface (mission statement,
per-feature spec folders, and the live roadmap).

**Forward links:**

- `docs/PRD.md` -> [`specs/mission.md`](../specs/mission.md) (the product's
  constitution lives here now)
- `docs/ROADMAP.md` -> [`specs/roadmap.md`](../specs/roadmap.md) (the live
  roadmap is per-feature in `specs/<date>-<name>/`)

These documents are archived, not deleted; their canonical successors
are in the `specs/` directory. See the validation contract
`VAL-DOC-014` for the assertion that gates this archive.

## Why archive instead of re-author

The original `docs/PRD.md` and `docs/ROADMAP.md` were static,
point-in-time documents that did not track the product's evolution.
The `specs/` directory instead carries the mission, a per-feature folder
pattern (`specs/YYYY-MM-DD-<name>/`) for active work, and a roadmap that
reflects the current feature pipeline. Re-authoring the PRD/ROADMAP
would have created two sources of truth; archiving them keeps the
`specs/` directory as the single live surface.
