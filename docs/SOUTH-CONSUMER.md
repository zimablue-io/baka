# South as first Baka consumer

Status: active  
Date: 2026-08-02  
Audience: agents implementing Baka for South (and other hosts)

## Why this exists

South orchestrates monorepo application projects. It does **not** reimplement plan/apply/validate. Baka is the HOW engine. Requirements below must be implemented **in this repo**, not duplicated in South.

## Product contract South will call

Stable operations (CLI `--json` and MCP must stay aligned):

| Op | Input | Output |
|----|--------|--------|
| list modules | cwd | name, version, description, actions |
| list actions | cwd, module | action ids + params schema |
| plan | cwd, intent | steps `{ id, module, action, params }` + status |
| apply | cwd, plan | completed/failed + validation |
| validate | cwd | pass/fail diagnostics |

Every durable step pin: **`moduleId + version + action + params`**.

## Module community model

- Modules are versioned (semver on manifest).
- Users **fork** a module to change HOW without mutating the original.
- Fork metadata keeps a clear link to the **source** module (id + version + source URL).
- South stores pins only; module bodies stay on disk/git/marketplace.

## Transport

- Primary: **cwd-bound** engine (stdio MCP and/or CLI).
- South binds a workspace path and invokes tools against that tree.
- Optional: Streamable HTTP on a **project worker** that already has the files — not a public multi-tenant “Baka SaaS with empty disk.”
- Do **not** block on MCP Apps branded UI for South. Structured JSON is enough for agents. Catalog listing UI can stay simple.

## Open work on Baka

Finish incomplete marketplace / community / landing work **before** inventing parallel surfaces. Fold South needs into that mission when active. If a mission is obsolete, cancel it explicitly — do not leave half-systems.

## What South will not do

- Import Baka private `@repo/*` packages into South as a second engine copy without a published boundary
- Reimplement SAGA or validators
- Reference other product monorepos inside Baka code for branding

## South decisions (read-only for context)

- South decision 036/037 (opinionated monorepo + separation) live under the South repo `docs/decisions/`.
