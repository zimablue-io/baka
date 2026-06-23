# API Contract Rules

**Owner**: Backend Team
**Last Updated**: 2026-06-12
**Applies to**: `apps/api/src/contracts/**`, `apps/api/src/router.ts`,
all ORPC procedures, all zod schemas that cross an API boundary.

## Procedures Don't Call Better Auth With Bearer-Token Headers

**Applies to**: Every procedure that uses the `authorized`
middleware (`apps/api/src/middleware/auth.ts`).

**Rule**: The auth middleware accepts two kinds of credentials:
a Better Auth session cookie (browser/dashboard) and an
app-issued JWT bearer token (CLI, desktop, future apps). When
the request only has the bearer token, Better Auth's
session-cookie APIs cannot resolve the user and they 500.

Don't call `auth.api.listOrganizations`, `auth.api.listMembers`,
`auth.api.getSession`, etc. with `headers: context.headers`
inside a procedure — that works for the session-cookie path
and silently breaks the bearer-token path. The right thing is
to read from the database (Better Auth's `member` and
`organization` tables are real Supabase tables) using
`context.user.id`, which the middleware populates for both
auth paths.

```ts
// ❌ Avoid: calls Better Auth with the original request headers.
// 500s when the request only has a bearer token (no session cookie).
const data = await auth.api.listOrganizations({ headers: context.headers })
```

```ts
// ✅ Correct: query the database directly using `context.user.id`,
// which the middleware populates for both auth paths.
const userId = context.user?.id
if (!userId) return []
const db = getDatabaseService()
const { data: memberships } = await db.getClient()
  .from('member').select('organizationId').eq('userId', userId)
const ids = (memberships ?? []).map((m) => m.organizationId)
const { data: rows } = await db.getClient()
  .from('organization').select('id, name, slug, logo, metadata, kind').in('id', ids)
return (rows ?? []).map(/* ... */)
```

**Rationale**: The dual-path auth in `authMiddleware`
(`apps/api/src/middleware/auth.ts`) populates `context.user`
identically for both paths. Procedures that use Better Auth
session APIs that require a cookie only work for the
session-cookie path. The bearer-token path is the one the
CLI and desktop use; the procedure must work for both. The
bug surfaced as a 500 on `users.getAllOrganizations` when the
CLI (with a freshly-minted bearer token from the new
PKCE auth flow) tried to call it.

**To check whether a procedure has this bug**: grep for
`auth.api.` in `apps/api/src/routers/**.ts` and verify the
call site either (a) runs from the browser (where Better Auth's
session cookie is present), or (b) is admin/org-management and
not used by the CLI/desktop hot path. Note: the
`routers/auth/token.ts` PKCE bridge was deleted in Phase 0.5d;
the CLI v3 calls Better Auth directly via `createVanillaAuthClient`,
so the cookie-bearing browser flow is now the dashboard's
sign-in page, not a per-app callback route.

## Required Inputs Don't Get Defaults

**Applies to**: All zod schemas, all function arguments.

**Rule**: A `?? <constant>` or `|| <constant>` on a required input
is a bug hiding in a default. Required means required. The absence
should fail loud at the type system, the schema, or the boot — not
silently turn into a constant.

```ts
// ❌ Avoid: required arg with a default
function renderConfig(value: string) {
  const v = value ?? 'default' // value is required; default is a lie
  return v
}

// ❌ Avoid: zod required field with a sneaky default
const schema = z.object({
  targetEpisodes: z.number().optional().default(100),
})

// ❌ Avoid: env var with a default
const apiKey = process.env.API_KEY || 'dev-key'
```

```ts
// ✅ Correct: zod required field
const schema = z.object({
  targetEpisodes: z.number().int().positive(),
  windowEpisodes: z.number().int().positive(),
})

// ✅ Correct: env var, fail loud at boot
const apiKey = process.env.API_KEY
if (!apiKey) throw new Error('API_KEY is required')
```

**Exception** (rare; require a comment): a feature flag with a
sensible "off" default, an optional override, a development-only
fallback. In all of these, the field is genuinely optional at the
type level, the default is documented at the use site, and the
default is not on a value the caller is supposed to provide. If
any of those three is false, the `??` is a bug.

**Rationale**: A default on a required input defeats all three
sources of truth — the TypeScript type, the zod schema, and the
runtime check. The error surfaces far from the cause, in a
production caller, with no stack trace pointing to the missing
field.

## Validate All External Input

**Applies to**: API routes, server actions, form handlers, anything
that takes user or external input.

**Rule**: Use Zod to validate all input from users or external
sources. Parse, don't trust.

```ts
import { z } from 'zod'

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
})

export async function createUser(input: unknown) {
  const data = CreateUserSchema.parse(input)
  // data is now typed AND validated
}
```

## Every Procedure Has a Zod Schema

**Applies to**: All ORPC procedures.

**Rule**: Every `.handler()` is preceded by `.input(z.object({...}))`
and `.output(z.object({...}))`. There is no "trust the caller" path.

## No `as` on API Responses

**Applies to**: All API response handling.

**Rule**: `as Foo` on an API response bypasses the type system. Use
a zod parse or a type guard. See `typescript.md` for the full
treatment.

## Env Validation at Boot

**Applies to**: Application startup.

**Rule**: Validate required env vars exist at startup. Don't
`process.env.X || 'dev-default'` — let the process crash with a
clear message.

```ts
// ✅ Correct
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  API_KEY: z.string().min(1),
})

export const env = EnvSchema.parse(process.env)
```

## Never Expose Internal Errors

**Applies to**: All API error responses.

**Rule**: Log detailed errors server-side; return generic messages
to clients.

```ts
// ✅ Correct
try {
  await processPayment(data)
} catch (error) {
  console.error('Payment failed:', error) // detailed log
  throw new ApiError('Payment processing failed', 500) // generic message
}
```

## Check Authentication on Every Protected Route

**Applies to**: All API routes requiring auth.

**Rule**: Use middleware or guards. Never assume auth from the
client.

```ts
// ✅ Correct
export async function GET(request: Request) {
  const session = await getSession(request)
  if (!session) return new Response('Unauthorized', { status: 401 })
  // ... handle authenticated request
}
```

## Related rules

- `typescript.md` (no `as` casts)
- `error-handling.md` (let errors propagate, add context with `cause`)
- `nextjs.md` (server actions are thin orchestrators that call
  into `apps/api`)
- `agent-architecture.md` (local — the AI tools SSOT for this monorepo)

## Machine-readable patterns

```yaml
- id: api-no-fallback-for-required
  severity: high
  diff_regex:
    - "\\?\\?\\s*['\"`]?[\\w-]+['\"`]?"
    - "\\|\\|\\s*['\"`]?[\\w-]+['\"`]?"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
    - "__tests__/"
  prompt_regex:
    - "(?i)\\b(fallback|default)\\s+(for|on)\\s+(a\\s+)?required\\b"
    - "(?i)\\bdefault\\s+to\\s+\\d+\\b"
  suggestion: "Required means required. Don't ?? a constant onto a required input. Fail loud at the type, the schema, or boot. See .factory/rules/api.md."
  citations:
    - "https://zod.dev/?id=default"
    - "https://nodejs.org/api/process.html#processenv"
- id: api-no-as-on-response
  severity: high
  diff_regex:
    - "await\\s+\\w+\\.json\\(\\)\\s*\\)\\s*as\\s+[A-Z]\\w*"
    - "process\\.env\\s*\\)\\s*as\\s+(unknown\\s+as\\s+)?[A-Z]\\w*"
    - "searchParams\\.get\\(['\"][^'\"]+['\"]\\)\\s*as\\s+string"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\b(as\\s+(unknown\\s+as\\s+)?[A-Z]\\w*|trust\\s+the\\s+response|trust\\s+the\\s+env|trust\\s+the\\s+query\\s+string)\\b"
  suggestion: "Don't `as` an API response, env var, or query string. Parse it with zod. See .factory/rules/api.md and .factory/rules/typescript.md."
  citations:
    - "https://zod.dev/"
    - "https://www.typescriptlang.org/docs/handbook/type-narrowing.html"
- id: api-validate-input
  severity: medium
  diff_regex: []
  prompt_regex:
    - "(?i)\\bno\\s+schema\\b"
    - "(?i)\\btrust\\s+the\\s+caller\\b"
    - "(?i)\\binput\\s+not\\s+validated\\b"
  suggestion: "Every ORPC procedure has z.object input and output. Every handler parses with the schema. See .factory/rules/api.md."
  citations:
    - "https://zod.dev/"
    - "https://orpc.unnoq.com/docs/procedure"
- id: api-env-default
  severity: high
  diff_regex:
    - "process\\.env\\.[A-Z_]+\\s*\\|\\|\\s*['\"`]?\\w+['\"`]?"
    - "process\\.env\\.[A-Z_]+\\s*\\?\\?\\s*['\"`]?\\w+['\"`]?"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\b(dev|test)\\s+default\\b.*\\benv\\b"
  suggestion: "Don't `process.env.X || 'dev-default'`. Let the process crash with a clear message at boot. See .factory/rules/api.md."
  citations:
    - "https://nodejs.org/api/process.html#processenv"
- id: api-no-better-auth-with-bearer-headers
  severity: high
  prompt_regex:
    - "(?i)\\bauth\\.api\\.\\w+\\(\\{[^}]*headers:\\s*context\\.headers"
    - "(?i)\\bbetter\\s*auth\\b.*\\bheaders\\b.*\\bbearer\\b"
  suggestion: "Don't call `auth.api.*` with the request headers from a procedure that the CLI/desktop bearer-token path can reach. Better Auth's session APIs require a session cookie, which the bearer-token auth path doesn't have. Read from the database (member/organization tables) using `context.user.id` instead. See .factory/rules/api.md."
  citations:
    - "https://better-auth.com/docs/concepts/session-management"
```

### Observed (auto-logged)
- 2026-06-11 17:40 — `apps/cli/src/lib/config.ts:84` — return process.env.KABU_AGENT_USER_ID ?? 'kabu-cli-agent'
- 2026-06-12 10:25 — `apps/cli/src/commands/login.tsx:27` — super(message ?? 'Sign-in cancelled')
- 2026-06-12 10:25 — `apps/cli/src/lib/config.ts:74` — return process.env.KABU_ORG_API_KEY ?? readConfig().token
- 2026-06-12 14:02 — `apps/cli/src/commands/login.tsx:28` — super(message ?? 'Sign-in cancelled')
- 2026-06-12 19:06 — `apps/cli/src/commands/login.tsx:85` — body: JSON.stringify({ json: input ?? null }),
- 2026-06-12 19:06 — `apps/cli/src/commands/login.tsx:169` — if (err.code === 'timeout' || err.code === 'cancelled') {
- 2026-06-12 19:06 — `apps/cli/src/lib/config.ts:81` — return process.env.KABU_ORG_API_KEY ?? readConfig().token
- 2026-06-12 19:06 — `apps/desktop/src/main/agent-daemon.ts:199` — // `userId ?? env ?? 'kabu-desktop-agent'` is a documented exception
- 2026-06-12 19:45 — `apps/cli/src/commands/login.tsx:88` — body: JSON.stringify({ json: input ?? null }),
- 2026-06-12 22:41 — `apps/api/src/middleware/auth.ts:32` — const organizationId = (firstMembership as { organizationId: string } | null)?.organizationId ?? null
- 2026-06-12 22:41 — `apps/api/src/middleware/auth.ts:45` — row && (row.kind === OrganizationKind.Creator || row.kind === OrganizationKind.Subscriber) ? row.kind : null
- 2026-06-15 10:41 — `apps/cli/src/commands/login.tsx:178` — const reason = err.reason ?? 'unknown'
- 2026-06-15 10:41 — `apps/cli/src/commands/login.tsx:182` — : reason === 'session_lookup_failed' || reason === 'exchange_threw'
- 2026-06-15 17:09 — `apps/api/src/middleware/auth.ts:35` — const organizationId = (firstMembership as { organizationId: string } | null)?.organizationId ?? null
- 2026-06-15 17:09 — `apps/api/src/middleware/auth.ts:48` — row && (row.kind === OrganizationKind.Creator || row.kind === OrganizationKind.Subscriber) ? row.kind : null
- 2026-06-15 17:09 — `apps/cli/src/lib/cli-args.ts:9` — if (first?.endsWith('cli.tsx') || first?.endsWith('cli')) return raw.slice(1)
- 2026-06-15 17:09 — `apps/desktop/src/main/agent-daemon.ts:178` — // `userId ?? env ?? 'kabu-desktop-agent'` is a documented exception
- 2026-06-15 21:12 — `packages/ts/payment/src/customers.ts:114` — if (!err || typeof err !== 'object') return false
- 2026-06-16 22:18 — `apps/admin/src/components/organizations-table.tsx:113` — : next.q !== undefined || next.kind !== undefined || next.plan !== undefined
- 2026-06-16 22:18 — `apps/admin/src/lib/table-url-state.ts:36` — if (!Number.isFinite(n) || n < 0) return 0
- 2026-06-16 22:18 — `apps/admin/src/pages/overview-page.tsx:121` — const isInitialLoading = totalsQuery.isPending || timeSeriesQuery.isPending || planQuery.isPending
- 2026-06-16 22:59 — `apps/admin/src/pages/overview-page.tsx:128` — const error = totalsQuery.error ?? timeSeriesQuery.error
- 2026-06-16 22:59 — `apps/admin/src/pages/overview-page.tsx:127` — const isInitialLoading = totalsQuery.isPending || timeSeriesQuery.isPending
- 2026-06-17 08:51 — `apps/cli/src/commands/login.tsx:237` — code: knownCode ?? 'unknown_code',
- 2026-06-17 08:51 — `apps/cli/src/commands/login.tsx:199` — if (reason === 'session_lookup_failed' || reason === 'exchange_threw') {
- 2026-06-17 08:57 — `apps/cli/src/commands/login.tsx:230` — code: knownCode ?? 'unknown_code',
- 2026-06-17 08:57 — `apps/cli/src/commands/login.tsx:192` — if (reason === 'session_lookup_failed' || reason === 'exchange_threw') {
- 2026-06-17 09:53 — `apps/cli/src/components/Header.tsx:46` — return `Signed in to ${auth.organizationKind ?? 'no'} org`
- 2026-06-17 09:53 — `apps/cli/src/components/Shell.tsx:432` — tokenCount={state.screen === 'agent-chat' || state.screen === 'agent' ? chatTokenCount : null}
- 2026-06-23 12:15 — `apps/cli/src/repl/Prompt.tsx:243` — `api-no-fallback-for-required` — const showPalette = isTTY && view.stage !== null && (visibleRows.length > 0 || showLoading)
