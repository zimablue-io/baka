# Next.js Rules

**Owner**: Frontend Team
**Last Updated**: 2026-06-11
**Applies to**: `apps/dashboard/**`, `apps/admin/**` (Next.js apps in this monorepo).

> All Next.js claims must be verified with `mcp__context7__query-docs`
> before writing code, because the App Router and Server Components
> APIs have changed substantially across Next.js 13 → 14 → 15 → 16.
> See `evidence-first.md`.

## Server Components by Default

**Applies to**: All `page.tsx` and `layout.tsx` files in the App Router.

**Rule**: Pages and layouts are **server components by default**. They
fetch data, render content, and stream HTML. They are not the right
place for `useState`, `useEffect`, or browser APIs.

```tsx
// ✅ Correct — app/(dashboard)/dashboard/page.tsx
import { PageHeader } from '@/components/layout/page/header'
import { DashboardGreeting } from '@/components/dashboard/dashboard-greeting'
import { DashboardOverview } from '@/components/dashboard/dashboard-overview'

export default function DashboardPage() {
  return (
    <>
      <PageHeader title={<DashboardGreeting />} />
      <DashboardOverview />
    </>
  )
}
```

```tsx
// ❌ Avoid — entire page is client
'use client'
import { useExperiments } from '@/hooks/use-experiments'

export default function DashboardPage() {
  const { data, isLoading } = useExperiments()
  if (isLoading) return <Skeleton />
  return <List data={data} />
}
```

**Rationale**: A client page adds to the client bundle, defeats
streaming, blocks static rendering of any sibling that is server-
rendered, and produces a hydration waterfall. If only a child needs
interactivity, make the child client.

## Push the 'use client' Boundary to Leaves

**Applies to**: Any component tree that mixes server and client.

**Rule**: If a child is interactive, make the child client. Do not
promote the parent so it can host a single client grandchild.

```tsx
// ✅ Correct shape
<ServerPage>             // server
  <ServerSection>        // server (fetches data, renders content)
    <ServerLeaf>         // server
    <ClientInteractive>  // 'use client'; smallest interactive unit
    </ServerLeaf>
  </ServerSection>
</ServerPage>
```

**Rationale**: Server-rendered content stays server-rendered. Only
the smallest possible unit becomes client.

## No Wrapper Client Components

**Applies to**: All React components in this monorepo.

**Rule**: A client component whose body is `<Child {...props} />` with
no logic of its own is a wrapper. Delete it and import the child
directly at the call site. Wrappers add a hydration boundary, a
client bundle chunk, and a layer of indirection that obscures the
real client/server split.

## No "Router Wrapper" Components

**Applies to**: All React components.

**Rule**: A component whose sole job is to choose between two
siblings based on a value (`if (x) return <A />; return <B />;`) is
a router wrapper. Branch at the call site (the server page), not in
a wrapper.

## Server Data First

**Applies to**: All pages.

**Rule**: Every page should be able to fetch its data on the server
and stream it. A page that fetches only on the client loses static
rendering, the ability to render without a JS bundle, and the
first-paint experience for users on slow networks.

## No `useEffect` to Set "Mounted"

**Applies to**: All React components.

**Rule**: Don't use `useEffect(() => setMounted(true), [])` to dodge
SSR/hydration mismatches. The right fix is the same fix as the
previous rules: make the shell a server component, make the
interactive leaf a client component, let the server stream the
shell.

```tsx
// ❌ Avoid
const [mounted, setMounted] = useState(false)
useEffect(() => setMounted(true), [])
if (!mounted) return <Skeleton />

// ✅ Better: make the shell server, the leaf client
```

**Rationale**: This pattern signals the author wanted a server-
rendered shell but wrote a client component instead. The right fix
is the boundary fix, not the state flag.

## Related rules

- `react.md` (component design — wrappers, no-op state, etc.)
- `evidence-first.md` (verify with Context7 before any of this)
- `testing.md` "Stateful Server Modules" (server modules with
  in-process state need a `vi.resetModules()` test)

## Machine-readable patterns

```yaml
- id: nextjs-server-first
  severity: high
  diff_regex:
    - "^['\"]use client['\"]"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\bmake\\s+(this|the\\s+\\w+)\\s+(page|layout|route|template)\\s+(a\\s+)?client\\b"
    - "(?i)\\b(use\\s+client|client\\s+component|client\\s+page|client\\s+layout)\\b"
  suggestion: "Pages and layouts are server components by default. Make the smallest interactive child a client component instead. See .factory/rules/nextjs.md."
  citations:
    - "https://nextjs.org/docs/app/getting-started/server-and-client-components"
    - "https://nextjs.org/docs/app/building-your-application/rendering/server-components"
- id: nextjs-no-wrapper-client
  severity: medium
  diff_regex:
    - "^export\\s+(default\\s+)?function\\s+[A-Z]\\w*\\s*\\("
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\b(create|make|use|add|introduce|need)\\b.*\\bwrapper\\b"
    - "(?i)\\bwrapper\\s+component\\b"
  suggestion: "A component whose body is just <Child {...props} /> is a wrapper. Delete it; import the child directly. See .factory/rules/nextjs.md."
  citations:
    - "https://react.dev/reference/react/Component"
- id: nextjs-no-mounted-flag
  severity: medium
  diff_regex:
    - "useEffect\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*setMounted\\s*\\("
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\bmounted\\s+flag\\b"
    - "(?i)\\buseState\\(false\\).*setMounted\\(true\\)"
  suggestion: "Don't dodge SSR/hydration mismatches with a useEffect-mounted flag. Make the shell a server component. See .factory/rules/nextjs.md."
  citations:
    - "https://react.dev/reference/react/useEffect"
```

### Observed (auto-logged)
- 2026-06-16 22:41 — `apps/admin/src/components/slow-load-hint.tsx:10` — export function SlowLoadHint() {
