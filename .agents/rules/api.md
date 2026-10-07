# API Contract Rules

**Owner**: Backend Team
**Last Updated**: 2026-06-12
**Applies to**: `apps/registry/src/**`, all zod schemas that cross an
API boundary.

## Don't Call Better Auth Session APIs With Bearer-Token Headers

**Applies to**: Every registry route that reads the caller's identity
(`apps/registry/src/auth/identity.ts`,
`apps/registry/src/auth/org-routes.ts`).

**Rule**: Better Auth's session APIs resolve a user from a session
cookie. A request that carries only an app-issued JWT bearer token has
no cookie, so those calls return no session and the handler has no
`user.id` to work with.

Don't call `auth.api.listOrganizations`, `auth.api.listMembers`,
session APIs such as `auth.api.getSession` resolve a user from the
cookie only. A bearer-token request silently yields no user.

```ts
// ❌ Avoid: resolves the caller from the session cookie alone.
// Returns no session when the request carries only a bearer token.
const session = await auth.api.getSession({ headers: context.headers })
```

```ts
// ✅ Correct: resolve identity from the credential the route actually
// received, then read authorization state from the database.
const identity = await resolveIdentity(request)  // cookie OR bearer token
if (!identity) return new Response('unauthorized', { status: 401 })
const { data: memberships } = await db.getClient()
  .from('member').select('organizationId').eq('userId', identity.userId)
return (memberships ?? []).map((m) => m.organizationId)
```

**Rationale**: a route that accepts both credential types but
resolves identity from only one of them looks correct and fails on the
other. Read the credential the route actually received.

**To check**: grep for `auth.api.getSession` under
`apps/registry/src/**` and confirm each call site resolves the bearer
path as well as the cookie path.

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
  suggestion: "Required means required. Don't ?? a constant onto a required input. Fail loud at the type, the schema, or boot. See .agents/rules/api.md."
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
  suggestion: "Don't `as` an API response, env var, or query string. Parse it with zod. See .agents/rules/api.md and .agents/rules/typescript.md."
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
  suggestion: "Every ORPC procedure has z.object input and output. Every handler parses with the schema. See .agents/rules/api.md."
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
  suggestion: "Don't `process.env.X || 'dev-default'`. Let the process crash with a clear message at boot. See .agents/rules/api.md."
  citations:
    - "https://nodejs.org/api/process.html#processenv"
- id: api-no-better-auth-with-bearer-headers
  severity: high
  prompt_regex:
    - "(?i)\\bauth\\.api\\.\\w+\\(\\{[^}]*headers:\\s*context\\.headers"
    - "(?i)\\bbetter\\s*auth\\b.*\\bheaders\\b.*\\bbearer\\b"
  suggestion: "Don't call `auth.api.*` with the request headers from a procedure that the CLI/desktop bearer-token path can reach. Better Auth's session APIs require a session cookie, which the bearer-token auth path doesn't have. Read from the database (member/organization tables) using `context.user.id` instead. See .agents/rules/api.md."
  citations:
    - "https://better-auth.com/docs/concepts/session-management"
```
