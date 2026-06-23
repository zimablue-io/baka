# Testing Rules

**Owner**: Platform Team
**Last Updated**: 2026-06-11
**Applies to**: All test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`,
`*.spec.tsx`, `tests/test_*.py`, `tests/**/test_*.py`) in this monorepo.

## Tests Describe Behavior, Not Implementation

**Applies to**: All test files.

**Rule**: A test should answer the question "what does this thing
do?" not "does this function call that function?" If your test
breaks when you rename an internal helper, the test is too tightly
coupled to the implementation.

## Colocate Test Files

**Applies to**: All tests except E2E.

**Rule**: Place test files next to source files.

```
src/
└── components/
    └── UserCard/
        ├── UserCard.tsx
        ├── UserCard.test.tsx   # colocated
        └── index.ts
```

## E2E Tests in Dedicated Directory

**Applies to**: End-to-end tests.

**Rule**: Place E2E tests in `e2e/` (Cypress) or `tests/e2e/`
(Playwright) at the project root.

## Descriptive Test Names

**Applies to**: All test cases.

**Rule**: Format as "should [action] when [condition]".

```ts
// ✅ Correct
it('should display error message when login fails', () => {})
it('should redirect to dashboard when login succeeds', () => {})

// ❌ Avoid
it('login error', () => {})
it('works', () => {})
```

## One Behavior Per Test

**Applies to**: All test cases.

**Rule**: A test name with "and" in it is two tests. Split it.
Tests that assert three unrelated things are hard to debug when
they fail and easy to skip when they pass for the wrong reason.

```ts
// ✅ Correct — testing one behavior
it('should format user name correctly', () => {
  const result = formatUserName({ first: 'John', last: 'Doe' })
  expect(result).toBe('John Doe')
})

// ✅ Also correct — same behavior, multiple aspects
it('should return complete user object', () => {
  const user = createUser('John')
  expect(user.id).toBeDefined()
  expect(user.name).toBe('John')
  expect(user.createdAt).toBeInstanceOf(Date)
})
```

## Mock at the Boundary

**Applies to**: All mocked dependencies.

**Rule**: Mock external APIs and services, not internal functions.

```ts
// ✅ Correct — mock external API
vi.mock('@/lib/api', () => ({
  fetchUser: vi.fn().mockResolvedValue({ id: '1', name: 'John' }),
}))

// ❌ Avoid — mock internal implementation
vi.mock('@/utils/formatName', () => ({
  formatName: vi.fn().mockReturnValue('John'),
}))
```

## Use MSW for API Mocking in Integration Tests

**Applies to**: Integration tests that need API responses.

**Rule**: Use Mock Service Worker instead of mocking fetch
directly.

```ts
import { http, HttpResponse } from 'msw'

const handlers = [
  http.get('/api/users', () => {
    return HttpResponse.json([{ id: '1', name: 'John' }])
  }),
]
```

## No Skipped Tests

**Applies to**: All test files.

**Rule**: A skipped test is a silent gap in the contract. Either
fix it or delete it. The root `AGENTS.md` enforces this for the
project test suites. The deliberate exceptions are documented
there ("Shipping-Artifact Tests" section).

## Pristine Output

**Applies to**: All test runs.

**Rule**: A test run should have zero errors and zero warnings. A
new warning is a regression; treat it like a failed test.

## Stateful Server Modules: Test the Real Lifecycle

**Applies to**: Server modules that mutate in-process state
(in-memory stores, caches, rate limiters, idempotency keys, feature
flags).

**Rule**: A server module that declares a top-level
`const store = new Map()` (or `const cache = new LRU()` or
`const flag = false`) lives in the **module's scope**. In dev mode,
Next.js / Vite / Turbopack can re-evaluate that module between
requests — HMR, route-segment boundaries, and lazy chunk loading
all create fresh module scopes. A unit test that imports the module
once and calls it twice is testing the **same instance twice** —
the test never sees the production failure mode where each
request gets a different instance.

If the module holds state that needs to persist across requests,
**the module must use `globalThis` (or another long-lived host) to
hold the state.** A `Symbol.for(...)` key avoids collisions with
other code. The test must verify the state survives across
`vi.resetModules()` and a re-import — that is the
production-equivalent assertion.

```ts
// ✅ Correct: state on globalThis
const STORE_KEY = Symbol.for('@kabu/server/pairing-store')
const host = globalThis as unknown as { [k: symbol]: Map<string, Entry> | undefined }
if (!host[STORE_KEY]) host[STORE_KEY] = new Map()
const store: Map<string, Entry> = host[STORE_KEY]!
```

```ts
// ✅ Correct: integration test that re-imports
beforeEach(() => {
  const host = globalThis as unknown as { [k: symbol]: unknown }
  delete host[Symbol.for('@kabu/server/pairing-store')]
  vi.resetModules()
})

it('shares state across module re-evaluations', async () => {
  const firstImport = await import('@/lib/server/pairing-store')
  firstImport.put('k', { v: 1 })
  vi.resetModules()
  const secondImport = await import('@/lib/server/pairing-store')
  expect(secondImport.get('k')).toEqual({ v: 1 })
})
```

```ts
// ❌ Avoid: module-scope state that loses on re-import
const store = new Map<string, Entry>() // lives in module scope
```

**Applies when**: in-memory pairing stores, idempotency keys,
rate limiters, server-side caches keyed by request data, liveness
flags, kill switches, runtime config — anything the user said
should be "shared across requests" or "remember for a few
minutes."

**Does not apply when**: per-request state held in a function's
local scope, pure functions, or modules whose state lives in a
database (Supabase, Redis, SQLite) — the database is the shared
host, not the module.

**Tests-first signal**: If you find yourself writing
`vi.mock('@/lib/server/pairing-store', () => ({ put: vi.fn(), get: vi.fn() }))`
to test a route handler, the test is verifying the route
handler's call shape — not the integration. Add a separate
integration test that re-imports the real module and verifies the
state survives.

## Related rules

- `tdd.md` (write the failing test first)
- `nextjs.md` (server components and the dev-mode module reload
  hazard)
- `evidence-first.md` (verify with Context7 before writing tests
  for an external library)

## Machine-readable patterns

```yaml
- id: no-skipped-test
  severity: high
  diff_regex:
    - "(^|\\s)(it|test|describe)\\.skip\\s*\\("
    - "(^|\\s)(it|test|describe)\\.todo\\s*\\("
    - "@pytest\\.mark\\.skip"
    - "@unittest\\.skip"
  exclude_paths:
    - "tests/py/containers/pytest\\.ini$"
  prompt_regex:
    - "(?i)\\b(skip|skipping)\\s+(this\\s+)?test\\b"
    - "(?i)\\btest\\.skip\\b"
  suggestion: "A skipped test is a silent gap in the contract. Either fix it or delete it. See .factory/rules/testing.md."
  citations:
    - "https://vitest.dev/api/test.html#skip"
    - "https://docs.pytest.org/en/stable/how-to/skipping.html"
- id: no-mock-internal
  severity: medium
  diff_regex:
    - "vi\\.mock\\(['\"]@/"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\bmock\\s+(the\\s+)?internal\\b"
    - "(?i)\\bmock\\s+implementation\\b"
  suggestion: "Mock at the boundary (external APIs, services, time, randomness), not on the thing under test. See .factory/rules/testing.md."
  citations:
    - "https://vitest.dev/api/vi.html#vi-mock"
    - "https://mswjs.io/docs/"
- id: stateful-module-global-host
  severity: medium
  diff_regex:
    - "^\\s*const\\s+[A-Za-z_][A-Za-z0-9_]*\\s*=\\s*new\\s+(Map|Set|WeakMap|WeakSet)\\(\\s*\\)"
  exclude_paths:
    - "/__tests__/"
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\b(in\\s*memory|in\\s*process|shared\\s+state|server\\s*side\\s*store)\\b"
  suggestion: "If this module holds in-process shared state, anchor it on globalThis with Symbol.for(...) and add a vi.resetModules() integration test. See .factory/rules/testing.md (Stateful Server Modules)."
  citations:
    - "https://nextjs.org/docs/app/building-your-application/routing/route-handlers"
```
