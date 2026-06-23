# TypeScript Rules

**Owner**: Platform Team
**Last Updated**: 2026-06-11
**Applies to**: All `*.ts` and `*.tsx` files in this monorepo.

## Use `interface` for Object Shapes

**Applies to**: All type definitions for objects.

**Rule**: Use `interface` for object types, `type` for unions,
intersections, and primitives.

```ts
// ✅ Correct
interface User {
  id: string
  name: string
}

type Status = 'active' | 'inactive'
type UserWithStatus = User & { status: Status }
```

## Avoid `any`

**Applies to**: All TypeScript files.

**Rule**: Never use `any`. Use `unknown` with type guards, or
define proper types.

```ts
// ✅ Correct
function processData(data: unknown): string {
  if (typeof data === 'string') return data.toUpperCase()
  throw new Error('Expected string')
}

// ❌ Avoid
function processData(data: any): string {
  return data.toUpperCase()
}
```

## Use Early Returns

**Applies to**: All functions with conditionals.

**Rule**: Return early for edge cases instead of nesting.

```ts
// ✅ Correct
function processUser(user: User | null): string {
  if (!user) return 'No user'
  if (!user.active) return 'User inactive'
  return `Processing ${user.name}`
}
```

## No `as` on Contracts

**Applies to**: All API response handling, all `process.env.*` reads
without a guard, all `JSON.parse` results.

**Rule**: There are exactly two places where `as` is acceptable:

1. **Narrowing inside a type guard**, where TypeScript will reject
   the cast unless the guard has already established the narrower
   type.
2. **Compile-time-only escape hatches** with a clear comment (e.g.
   `as unknown as Foo`), followed immediately by a `zod` parse.

You do not use `as` to "trust" an API response. You parse it.

```ts
// ❌ Avoid: trusting an API response
const res = await fetch('/api/experiments')
const data = (await res.json()) as Experiment[]

// ❌ Avoid: trusting an env var
const env = process.env as unknown as { NODE_ENV: 'production' | 'development' }

// ❌ Avoid: trusting a query string
const id = searchParams.get('id') as string
```

```ts
// ✅ Correct: zod parse
const res = await fetch('/api/experiments')
const json = await res.json()
const data = ExperimentListSchema.parse(json)

// ✅ Correct: validated env
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  API_KEY: z.string().min(1),
})
export const env = EnvSchema.parse(process.env)

// ✅ Correct: explicit null check
const id = searchParams.get('id')
if (!id) throw new BadRequestError('id is required')
```

**Rationale**: An `as` cast bypasses the type system. If the API
ever returns something that is not `Foo`, the type system will not
catch it. The error surfaces far from the cause, in a production
caller.

## Related rules

- `api.md` (zod-validated API contracts, validated env at boot)
- `nextjs.md` (server components, push client to leaves)
- `error-handling.md` (no empty catch)

## Machine-readable patterns

```yaml
- id: typescript-no-any
  severity: medium
  diff_regex:
    - ":\\s*any\\b"
    - "<any>"
    - "as any\\b"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\b(use|use\\s+of)\\s+any\\b"
    - "(?i)\\bany\\s+type\\b"
  suggestion: "Never use any. Use unknown with a type guard or define a proper type. See .factory/rules/typescript.md."
  citations:
    - "https://www.typescriptlang.org/docs/handbook/2/narrowing.html"
- id: typescript-prefer-interface
  severity: low
  diff_regex: []
  prompt_regex: []
  suggestion: "Use interface for object shapes; use type for unions, intersections, primitives. See .factory/rules/typescript.md."
  citations:
    - "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html"
- id: no-require-in-esm
  severity: high
  diff_regex:
    - "=\\s*require\\s*\\(\\s*['\"]"
    - "return\\s+require\\s*\\(\\s*['\"]"
    - "//\\s*eslint-disable[^\\n]*no-require-imports"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
    - "\\.cjs\\."
    - "/scripts/"
    - "apps/cli/bin/"
  prompt_regex:
    - "(?i)\\brequire\\s*\\(\\s*['\"][^'\"]+['\"]"
    - "(?i)\\blazy\\s+require\\b"
  suggestion: |
    The CLI is an ESM module (`"type": "module"` in
    apps/cli/package.json). `require` is not defined in
    ESM. Use top-level `import` statements. The `require`
    pattern almost always ships a runtime
    `ReferenceError: require is not defined` (the exact
    crash a user hit on 2026-06-15 — see commit a734e52e
    for context). The
    `// eslint-disable-next-line @typescript-eslint/no-require-imports`
    comment is the tell: someone added it to silence the
    lint warning without addressing the underlying ESM
    incompatibility. If you need to gate a heavy import on
    a runtime condition, use a dynamic `import()` (which
    is ESM-native and returns a Promise) or split the
    heavy path into a separate module that the consumer
    imports lazily via React.lazy / Suspense (if the host
    supports it).
  citations:
    - "https://nodejs.org/api/esm.html"
    - "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import"
```

### Observed (auto-logged)
- 2026-06-23 10:33 — `apps/api/src/middleware/auth.ts:30` — type AuthNext = MiddlewareNextFn<any>
- 2026-06-23 10:44 — `apps/api/src/middleware/auth.ts:29` — type AuthNext = MiddlewareNextFn<any>
