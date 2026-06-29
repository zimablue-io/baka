# better-chat-boundaries

Captured boundary-check module for the better-chat monorepo. Runs the
boundary check directly against the live better-chat source using the
rule data in `manifest.ts`, reports structured pass/fail diagnostics,
and never mutates the live tree.

## Why this module exists

better-chat's `scripts/check-boundaries.mjs` enforces 11 import
boundaries. The baka engine needs a way to invoke that same check
from the `baka validate` CLI and from MCP tools. This module captures
the FORBIDDEN list as data and re-implements the check algorithm in
TypeScript (in `_shared/helpers/run-check.ts`) so the validator works
reliably regardless of how the legacy script is invoked.

## Why not just spawn `scripts/check-boundaries.mjs`?

The legacy script has two pre-existing bugs that make a sub-process
invocation unreliable for our purposes:

1. **Unresolvable `glob` import.** The script does
   `await import("glob")` to walk each source package directory.
   `glob` is not a direct dependency of better-chat, so the dynamic
   import fails in pnpm-hoisted layouts. The script's outer
   `try/catch` silently skips every rule, and the validator always
   reports PASS even when violations exist.

2. **Broken `forbiddenName` construction.** The script builds
   `forbiddenName` with
   `forbiddenDir.replace("packages/", "@repo/")`. For rule
   `["packages/database/src", "packages/database/src"]` this yields
   `"@repo/database/src"`, but normal imports use the bare
   `@repo/database` form. The equality check then never matches.

Both bugs are pre-existing in `scripts/check-boundaries.mjs` (which
is read-only per the mission's boundaries). The captured module
owns the boundary check algorithm; the manifest owns the rules. The
legacy script remains untouched as a "fast local fallback" the user
can still invoke directly with `pnpm check-boundaries`.

## The 11 boundary rules

| # | Source package dir | Forbidden import |
|---|---|---|
| 1 | `packages/ai-media/src` | `@repo/database` |
| 2 | `packages/database/src` | `@repo/ai-media` |
| 3 | `packages/characters/src` | `@repo/database` |
| 4 | `packages/common/src` | `@repo/database` |
| 5 | `packages/common/src` | `@repo/ai-media` |
| 6 | `packages/common/src` | `@repo/characters` |
| 7 | `packages/ui/src` | `@repo/ai` |
| 8 | `packages/auth/src` | `@repo/ai` |
| 9 | `packages/payment/src` | `@repo/ai` |
| 10 | `packages/ai-media/src` | `@repo/ai-3d` |
| 11 | `packages/ai-3d/src` | `@repo/ai-media` |

The 11 entries are byte-for-byte the FORBIDDEN array in
`better-chat/scripts/check-boundaries.mjs`. The validation
contract's `VAL-DOG-003` calls for "12 boundary rules" — see
[the 11 vs 12 discrepancy](#the-11-vs-12-discrepancy) below.

## Usage

From the better-chat root:

```bash
# Run the boundary check via the baka CLI
baka validate --module better-chat-boundaries --json

# Or, the same thing via the MCP tool
baka_mcp baka_validate --module better-chat-boundaries
```

The module is also callable from the orchestrator (`baka plan
"add a new package boundary rule for ai-3d"`) via its single
`validate` action, which delegates to
`_shared/helpers/run-check.ts`. The legacy `pnpm check-boundaries`
script remains a fast local fallback; nothing here is meant to
replace it.

## Read-only contract

The validate action must not mutate the live better-chat source
(VAL-DOG-008). The implementation in
`_shared/helpers/run-check.ts` honours that contract by:

1. Walking each `BOUNDARY_RULES.sourcePkg` directory with Node's
   built-in `fs.readdirSync` (no third-party glob dependency).
2. Reading each `.ts` file with `fs.readFileSync` only.
3. Parsing imports line-by-line with the same regex the legacy
   script uses (`/from ['"](@repo\/[^'"]+)['"]/`) and the same
   comment-skipping heuristic.

No subprocess, no scratch directory, no symlinks. The live source's
mtimes never change because no write ever happens.

## Diagnostic shape

Each violation is surfaced as a `ValidationDiagnostic` with:

```ts
{
  severity: "error",
  rule: "check-boundaries",
  message: "packages/ui/src/index.ts:7: imports '@repo/ai' which is forbidden",
  file: "packages/ui/src/index.ts",
  hint: "forbiddenImport=@repo/ai"
}
```

The `hint` field carries the forbidden import verbatim so an
agent reading the diagnostic can map it back to the matching
`BOUNDARY_RULES` entry without re-parsing `message`.

## The 11 vs 12 discrepancy

The validation contract's `VAL-DOG-003` says the manifest declares
"12 boundary rules" and the count is "12 in both" the manifest and
the legacy script. The actual `FORBIDDEN` array in the legacy script
has **11** entries (verified by reading
`better-chat/scripts/check-boundaries.mjs`). The contract appears
to over-count by one.

The mission library note (`library/better-chat-boundaries.md`) flags
this explicitly and instructs the worker to declare the 11 rules
that match the legacy script verbatim, document the discrepancy,
and let `diff` of `sourcePkg + " " + forbiddenImport` lines be
empty. We follow that guidance: the manifest declares 11 rules
(not 12), the `diff` against the script is empty (the contract's
stronger half), and the count assertion in the contract (12 in
both) is a known off-by-one that needs a contract update.

If the 12th rule is ever wanted, the natural candidate is the
"common must not import from any other `@repo` package" rule
(per the legacy script's JSDoc). The script enforces this for
`database`, `ai-media`, and `characters` only — the missing
cases (`ui`, `auth`, `payment`, `ai`, `ai-3d`) are an intentional
or unintentional gap in the legacy script, not in the captured
module.
