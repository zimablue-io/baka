# Maintenance Rules

**Owner**: Platform Team
**Last Updated**: 2026-06-15
**Applies to**: All `*.ts`, `*.tsx`, `*.py` files in this monorepo.

## No Compatibility Shims in Active Code

**Applies to**: All production code (not tests, not CHANGELOG, not
markdown).

**Rule**: No `// backward compat` branches, no `// legacy` paths,
no `if (oldAPI)` blocks. The "No Patch-Over" rule from the root
`AGENTS.md`. When you change an API, a shape, a config key, or a
flow, you migrate callers and delete the old path in the same
change.

```ts
// ❌ Avoid
function getBearerToken() {
  // Backward compat: legacy session-token getters.
  const legacy = getLegacySessionToken()
  if (legacy) return legacy
  return readConfig('orgApiKey')
}
```

```ts
// ✅ Correct
function getBearerToken() {
  const apiKey = readConfig('orgApiKey')
  if (!apiKey) throw new UnauthorizedError('Org API key required')
  return apiKey
}
```

**Rationale**:

- A compat shim doubles the surface area you have to test, document,
  and reason about.
- A compat shim hides bugs in the migration: if the old path is
  still there, callers can still hit it, and you have no way to
  know which path is "live."
- A compat shim rots. The old path gets less and less attention;
  the new path gets more.

## The Only Allowed Compat Pattern: Logging Deprecation

**Applies to**: All migrations that delete an old API.

**Rule**: The only "compat" we allow is a *logging-only*
deprecation: emit a warning when the old path is used, run for one
release, then delete. A working fallback is forbidden.

```ts
// ✅ Acceptable: logging-only deprecation, run for ONE release
function getOldApiKey() {
  logger.warn('getOldApiKey is deprecated; use getOrgApiKey')
  return legacyStorage.read()
}
```

**Rationale**: A working fallback is the bug; a deprecation log
gives callers a chance to migrate without silently breaking.

## Related rules

- `api.md` (validated env at boot, fail loud not silent)
- `error-handling.md` (no catch + log + continue; that is the
  cousin of the compat shim)
- Root `AGENTS.md` "No Patch-Over Rule"

## A Feature Rewrite Lands as One Coherent App State

**Applies to**: Any change that rewrites a subsystem (CLI
commands, an API router, a UI surface, a config schema, an auth
flow, a data model). The "subsystem" is the entry point and
everything that imports from it, calls into it, or is called by
it.

**Rule**: A rewrite/area is *done* when the whole subsystem
works end-to-end from a fresh checkout, not when the new files
are written. The commit boundary must be a coherent app state:

- If the new entry point replaces an old one, every caller of
  the old entry point is updated **in the same change** (or
  removed if the old path is gone).
- If a new module is added and an old one is no longer used, the
  old module is **deleted in the same change** (the "No
  Compatibility Shims in Active Code" rule above forbids leaving
  it as dead-but-present code).
- If docs (AGENTS.md, README.md, package-level guides) describe
  the subsystem, they are updated to describe the **actual code
  in the same commit**, not a previous design that the new
  code does not implement.
- If the rewrite touches the entry point of an app (e.g.
  `cli.tsx`, `router.ts`, `main.tsx`), `git status` after the
  work is complete must show *no* M or D files inside the
  subsystem's directory that the change did not also stage.

```ts
// ❌ Avoid: "I rewrote the entry point, but the rest of the
// app still imports from the deleted module."
// cli.tsx now renders <Shell />, but commands/agent.tsx
// still imports from the deleted lib/org-queries.ts, the
// dead code that fed the old useState soup. The app builds
// locally on the agent's machine, but breaks on a clean
// checkout.
```

```ts
// ✅ Correct: the rewrite ships with the whole subsystem.
// - Entry point: new (<Shell />)
// - Old useState soup: deleted (interactive-app.tsx)
// - Dead helpers that fed it: deleted (lib/org-queries.ts)
// - Updated callers: commands/agent.tsx, commands/run-start.tsx
//   all switched to the new lib/config.ts API.
// - Docs: AGENTS.md and README.md describe the new PKCE flow,
//   not a polling flow that was never implemented.
```

**Rationale**: A "partial" commit is a silent lie. The author
sees their own tree work; a fresh checkout sees the union of
all the uncommitted fragments. The user reads "feat(cli):
rewrite interactive app" in the commit log and assumes the CLI
is done; in reality, the new entry point imports from modules
that no longer exist, or co-exists with code that calls the
deleted entry point. The session that produced the
`2026-06-15 09:35` `wtf` signal is the canonical case: a
rewrite was committed without the rest of the subsystem
landing, and the user spent the next turn explaining that
"ALL the cli logic IS YOURS."

**See also**: `apps/cli/AGENTS.md` for the CLI's current
end-to-end state after the rewrite; commits `a9b1af6c` and
`d3f57783` for the rewrite and its completion respectively.

## Machine-readable patterns

```yaml
- id: no-compat-shim-active-code
  severity: high
  diff_regex:
    - "\\b(legacy|backward|backwards)[-_ ]?(compat|compatibility)\\b"
    - "//\\s*legacy\\s+(fallback|path|code|api)"
    - "//\\s*for\\s+backward(s)?\\s+compatibility"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
    - "CHANGELOG\\.md$"
    - "\\.md$"
  prompt_regex:
    - "(?i)\\b(backward|backwards|legacy)\\s+(compat|compatibility|fallback|path)\\b"
    - "(?i)\\bfor\\s+backward(s)?\\s+compat(ibility)?\\b"
  suggestion: "No compat shims in active code. Migrate callers and delete the old path in the same change. The only allowed pattern is a logging-only deprecation that runs for one release. See .factory/rules/maintenance.md."
  citations:
    - "https://en.wikipedia.org/wiki/Deprecation"
- id: rewrite-lands-coherent
  severity: high
  diff_regex: []
  prompt_regex:
    - "(?i)\\bcommit\\b.*\\b(partial|half[-\\s]done)\\b"
    - "(?i)\\b(commit|land|ship)\\b.*\\bthe\\s+(rest|remainder|other\\s+files)\\b"
    - "(?i)\\bnew\\s+entry\\s+point\\b"
  suggestion: "A rewrite/area must land as a coherent end-to-end app state, not a partial one. If you changed the entry point, the rest of the subsystem (callers, dead code, docs) must be in the same commit. `git status` for the subsystem directory must show no unstaged M/D that the change did not also stage. See .factory/rules/maintenance.md."
  citations: []
- id: one-source-of-truth-for-app-state
  severity: high
  diff_regex:
    - "phase\\s*[:=]\\s*['\"](?:done|signed[_-]?in)['\"]"
    - "[Ll]ogged\\s*in\\.\\s*[Tt]oken\\s*saved"
    - "phase\\s*===\\s*['\"]done['\"]\\s*\\{[^{}]*[Ll]ogged\\s*in"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)phase.*done.*[Ll]ogged\\s*in"
    - "(?i)[Ll]ogged\\s*in.*[Tt]oken\\s*saved"
  suggestion: "Local component state MUST NOT contradict global app state. The `AuthState` in `apps/cli/src/state/auth.ts` is the single source of truth for 'is the user logged in?' — it is set by `verifyToken` (which round-trips the token to the server) and ONLY that can flip it to `'authenticated'`. A child component's local `phase: 'done'` or 'Logged in. Token saved.' message is a rogue SSOT and will lie to the user when the server is unreachable. After `runCliLogin` returns, render a 'verifying' placeholder and unmount the component as soon as the global auth state moves to 'verifying' — let the parent drive the next screen based on the SSOT. See .factory/rules/maintenance.md and apps/cli/AGENTS.md."
  citations:
    - "file:apps/cli/src/state/auth.ts"
    - "file:apps/cli/AGENTS.md"
- id: cli-defaults-to-production
  severity: high
  diff_regex:
    - "return\\s+['\"]https://localhost:\\d+['\"]"
    - "return\\s+['\"]http://localhost:\\d+['\"]"
    - "defaultBaseUrl\\s*[:=]\\s*['\"]https?://localhost"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
    - "\\.env"
    - "\\.envrc"
    - "env\\.example"
    - "\\.env\\.production"
  prompt_regex:
    - "(?i)\\bdefault\\s+to\\s+localhost\\b"
    - "(?i)\\bdefault\\s+(base\\s*)?url.*localhost\\b"
  suggestion: "A CLI app's hardcoded fallback URL (the value returned when no env var, no config file, no flag is set) MUST be the production site, not the dev site. A user who installs the CLI without configuring anything is by definition a production user; a 'default to localhost' silently breaks their install. Devs override via DASHBOARD_BASE_URL in their .env / .envrc. See .factory/rules/maintenance.md."
  citations: []
```

### Observed (auto-logged)
- 2026-06-23 11:01 — `packages/py/reinforcement_learning/tests/test_rllib_algorithm_registry.py:16` — # package; the orchestrator re-exports it for backward compat.
