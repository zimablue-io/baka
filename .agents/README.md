# Agent Rules (harness-agnostic)

These rules apply to the whole repo and are written to be readable by
any coding agent, not just one vendor's harness.

| Rule | Covers |
|------|--------|
| `rules/tdd.md` | Red-green-refactor, no production code without a failing test |
| `rules/evidence-first.md` | Read the real files, cite `file:line`, verify library docs before coding |
| `rules/typescript.md` | Strict TS, no `as` casts, no `any` escape hatches |
| `rules/react.md` | React 19 + TanStack Start patterns, hooks, server/client boundary |
| `rules/nextjs.md` | Next.js claims, checked against current docs when a Next.js module is authored |
| `rules/api.md` | API contracts, auth identity resolution, no defaulted required inputs |
| `rules/error-handling.md` | Let errors propagate, add context with `cause`, never swallow |
| `rules/testing.md` | Test layout, state isolation, what counts as proof |
| `rules/maintenance.md` | Refactors land as one coherent state; no residue for deleted code |

## Harness wiring

Nothing here is load-bearing for the build. `pnpm lint`, `pnpm test`,
`pnpm check-types`, and `pnpm knip` do not read this directory.

An agent harness that wants these rules should point at
`.agents/rules/`. Project memory lives in `memories.md` in this
directory. MCP server registration lives at the repo root `.mcp.json`.
