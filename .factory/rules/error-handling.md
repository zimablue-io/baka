# Error Handling Rules

**Owner**: Platform Team
**Last Updated**: 2026-06-15
**Last Updated**: 2026-06-11
**Applies to**: All `*.ts`, `*.tsx`, `*.py` files in this monorepo.

## Errors Propagate

**Applies to**: All `try`/`catch` and `try`/`except` blocks.

**Rule**: There are exactly three legitimate things to do with an
error:

1. **Let it propagate.** The caller (or the framework) handles it.
2. **Add context and rethrow.** `throw new Error('Failed to fetch X', { cause: e })`.
3. **Handle it meaningfully** — but only at a boundary where you
   actually know what to do (e.g. a UI that shows an error toast, a
   retry layer, a circuit breaker).

There is no fourth option. There is no "swallow because it's not
important." If it's not important, the call shouldn't be in a
`try`.

## No Empty Catch

**Applies to**: All `try`/`catch` and `try`/`except` blocks.

**Rule**: A `catch (e) {}` and an `except: pass` are forbidden.

```ts
// ❌ Avoid
try {
  await saveExperiment(config)
} catch (e) {
  // nothing
}
```

```python
# ❌ Avoid
try:
    save_experiment(config)
except Exception:
    pass
```

**Rationale**: Empty catches are the code that hides the bug, not
the code that fixes it. The next line that reads "did we save it?"
gets the wrong answer.

## No Catch + Log + Continue

**Applies to**: All catch blocks.

**Rule**: A catch that logs and continues is a slightly dressed-up
empty catch. The operation failed; the surrounding code is now
operating on a false assumption.

```ts
// ❌ Avoid
try {
  await saveExperiment(config)
} catch (e) {
  logger.error('save failed', e)
  // continue as if nothing happened
}
```

## Use `cause` When Rethrowing

**Applies to**: All `throw` statements inside a `catch` block.

**Rule**: When you rethrow, preserve the original error via
`cause`. A bare `throw new Error('Save failed')` loses the
stack trace.

```ts
// ❌ Avoid
try {
  await saveExperiment(config)
} catch (e) {
  throw new Error('Save failed')
}

// ✅ Correct
try {
  await saveExperiment(config)
} catch (e) {
  throw new Error('Failed to save experiment', { cause: e })
}
```

## When a `try` Is Legitimate

**Applies to**: All `try` blocks.

**Rule**: A `try` is legitimate when the catch does something
visible: rethrow, convert, or retry. The legitimate cases are:

- **At a UI boundary** where you must convert an error into a
  user-visible toast or redirect.
- **At a retry layer** with explicit retry/backoff policy.
- **At a process boundary** where the surrounding runtime demands
  a specific error contract (e.g. an ORPC handler that must
  rethrow as a `KabuError` subclass).

## Related rules

- `api.md` (never expose internal errors, log server-side only)
- `maintenance.md` (no compat shims — and "old error handling" is
  one of the things that gets left behind)

## Local Token ≠ Authenticated State

**Applies to**: All client apps that hold a bearer token in
local storage or a keychain (CLI, desktop, future apps).

**Rule**: A token existing in storage is a *credential*; it is
not an *authentication state*. Before any client UI is
allowed to claim "logged in" (or render authenticated
screens, or enable authenticated actions), the token MUST be
round-tripped to the server and a session context resolved.
The server's response, not the presence of a token, is what
flips the auth state to `authenticated`.

```ts
// ❌ Avoid: token present → "logged in"
// This is the "lying auth" anti-pattern. The dashboard says
// auth failed, the CLI says it succeeded, and every action
// silently 401s. The user is staring at a wall.
if (getBearer() !== undefined) {
  setAuth({ kind: 'authenticated' })
}
```

```ts
// ✅ Correct: round-trip before claiming authenticated
const token = getBearer()
if (token === undefined) {
  setAuth({ kind: 'absent' })
  return
}
setAuth({ kind: 'verifying' })
const session = await getSessionContext(client, token)
if (session.kind === 'ok') {
  setAuth({ kind: 'authenticated', organizationKind: session.organizationKind })
} else {
  setAuth({ kind: 'unreachable', error: session.error }) // or 'expired'
}
```

**Rationale**: Bearer tokens outlive sessions. A token can
survive a server-side revocation, a logout-everywhere action,
a user deletion, or a re-key. The only way to know the
session is still valid is to ask the server. Anything else
results in "auth succeeded but every action fails" — the
specific failure mode the user reported on 2026-06-11 18:55.

**See also**: `apps/cli/src/state/auth.ts` for the
reference implementation (`verifyToken`).

## Machine-readable patterns

```yaml
- id: no-empty-catch
  severity: high
  diff_regex:
    - "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}"
    - "except\\s*(Exception\\s*)?:\\s*pass"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\bempty\\s+catch\\b"
    - "(?i)\\bsilent\\s+catch\\b"
    - "(?i)\\bswallow\\s+the\\s+error\\b"
  suggestion: "Empty catches hide the bug, they don't fix it. Either rethrow with cause, or convert to a meaningful user-facing action. See .factory/rules/error-handling.md."
  citations:
    - "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/try...catch"
- id: no-catch-log-and-continue
  severity: medium
  diff_regex:
    - "catch\\s*\\([^)]*\\)\\s*\\{[^{}]*console\\.\\w+\\([^{}]*\\}"
    - "catch\\s*\\([^)]*\\)\\s*\\{[^{}]*logger\\.\\w+\\([^{}]*\\}"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\blog\\s+and\\s+continue\\b"
    - "(?i)\\blog\\s+and\\s+return\\b"
  suggestion: "A catch that logs and continues is a dressed-up empty catch. The operation failed; subsequent code runs on a false assumption. See .factory/rules/error-handling.md."
  citations:
    - "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/try...catch"
- id: no-rethrow-without-cause
  severity: low
  diff_regex:
    - "throw\\s+new\\s+Error\\([^)]*\\)\\s*;"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\bthrow\\s+new\\s+Error\\b(?!.*\\bcause\\b)"
  suggestion: "When rethrowing, preserve the original error with `cause`. A bare `throw new Error('Save failed')` loses the stack trace. See .factory/rules/error-handling.md."
  citations:
    - "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause"
- id: no-token-presence-as-auth-state
  severity: high
  diff_regex:
    - "if\\s*\\(\\s*getBearer\\s*\\(\\s*\\)\\s*(?:!==|!=)\\s*undefined\\s*\\)"
    - "if\\s*\\(\\s*getToken\\s*\\(\\s*\\)\\s*\\)\\s*\\{[^{}]*kind:\\s*['\"]authenticated['\"]"
    - "if\\s*\\(\\s*token\\s*\\)\\s*\\{[^{}]*kind:\\s*['\"]authenticated['\"]"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\btoken\\s+present\\s+.*\\s+logged\\s+in\\b"
    - "(?i)\\bif\\s*\\(\\s*token\\s*\\)\\s*\\{[^}]*auth"
  suggestion: "A token in storage is a credential, not an authentication state. Round-trip to the server (e.g. `verifyToken` / `getSessionContext`) before claiming authenticated. See .factory/rules/error-handling.md."
  citations:
    - "https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication"
- id: no-session-lookup-via-headers
  severity: high
  diff_regex:
    - "auth\\.api\\.getSession\\s*\\(\\s*\\{\\s*headers\\s*:\\s*context\\.headers"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
    - "/app/"
    - "\\.next/"
  prompt_regex:
    - "(?i)\\bauth\\.api\\.getSession\\b.*\\bcontext\\.headers\\b"
  suggestion: "Don't call auth.api.getSession({ headers }) from a server-side procedure that exists only to mint something for the requester. The request boundary (Next.js route, orpc procedure) should verify the session at its own boundary and pass the verified identity in. The inner procedure should not need to call Better Auth or Postgres just to mint a code. The route at `app/(authentication)/auth/callback/route.ts` IS the auth boundary, so it is allowed to call `auth.api.getSession({ headers: request.headers })` — that call IS the verification. See .factory/rules/error-handling.md."
  citations:
    - "https://better-auth.com/docs/concepts/session-management"
- id: recoverable-auth-states-are-not-errors
  severity: high
  diff_regex:
    - "relayToLoopback\\s*\\([^)]*loopbackUrl[^)]*['\"]no_session['\"]"
    - "redirect\\s*\\(\\s*loopbackUrl[^)]*\\?error=(?:no_session|login_required)"
    - "/auth/callback[^)]*\\?error=no_session"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)no_session.*(?:redirect|relay|abort)"
    - "(?i)loopback\\?error=(?:no_session|login_required)"
  suggestion: |
    "no_session" / "login_required" is a RECOVERABLE auth state,
    NOT an error. The browser is on the auth server's domain (the
    dashboard) and the user is not signed in — they can sign in.
    The standard pattern (OAuth 2.0 / RFC 8252) is to redirect the
    user to the auth server's sign-in page with a callbackUrl, they
    sign in, the auth server sets a session cookie, and the user
    lands back on /auth/callback?state=... to continue the flow.
    Only relay to a consumer's loopback for UNRECOVERABLE failures:
    session_lookup_failed (Postgres down — can't authenticate),
    already_redeemed (code is single-use), unknown_state (server
    lost the state), exchange_threw (server-side error).
    See .factory/rules/error-handling.md.
  citations:
    - "https://datatracker.ietf.org/doc/html/rfc8252"
    - "https://www.rfc-editor.org/rfc/rfc6749#section-4.1.2.1"
```
