# React Rules

**Owner**: Frontend Team
**Last Updated**: 2026-06-11
**Applies to**: `apps/dashboard/components/**`, `apps/admin/components/**`,
`packages/ts/ui/**`, `packages/ts/ui-chart/**`, `packages/ts/ui-chart-trading/**`.

> React 19 + Next.js 16 App Router. Server / client boundary rules
> live in `nextjs.md`. This file is for the React-specific patterns
> that apply on both sides of the boundary.

## Functional Components Only

**Applies to**: All React components.

**Rule**: Use functional components with hooks. Never use class
components.

## Props Interface Naming

**Applies to**: All components with props.

**Rule**: Name the props interface `{ComponentName}Props`. Export
it only when consumers need to compose around it.

```tsx
// ✅ Correct
interface UserCardProps {
  user: User
  onSelect: (user: User) => void
}

export function UserCard({ user, onSelect }: UserCardProps) {
  return <div onClick={() => onSelect(user)}>{user.name}</div>
}
```

## Component File Structure

**Applies to**: All component files.

**Rule**: Order sections as: imports, types, component, exports.

```tsx
// 1. Imports (React, external, internal, types)
import { useState } from 'react'
import { Button } from '@repo/ui/components/ui/button'
import type { User } from '@repo/common'

// 2. Types
interface UserListProps {
  users: User[]
}

// 3. Component
export function UserList({ users }: UserListProps) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <ul>
      {users.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}
```

## Named Exports Over Default

**Applies to**: All module exports.

**Rule**: Use named exports for better refactoring and import
clarity. `export function createUser() {}`, not `export default
function createUser() {}`. Page components are an exception (Next.js
requires `default`).

## No `useState` for Derivable Values

**Applies to**: All React components.

**Rule**: If a `useState` value is a function of a prop or of another
state value, use `useMemo` or compute it inline. Storing a derivable
value in `useState` invites the two to drift.

```tsx
// ❌ Avoid
const [filtered, setFiltered] = useState(users.filter(predicate))
useEffect(() => setFiltered(users.filter(predicate)), [users, predicate])

// ✅ Correct
const filtered = useMemo(() => users.filter(predicate), [users, predicate])
```

## Independent Rendering (No Waterfalls)

**Applies to**: All React components.

**Rule**: Each section must be able to render as soon as its data is
available. Don't chain `useEffect` calls that each await the
previous one. Don't make the parent fetch the data the child needs;
either fetch it server-side and pass it down, or have the child
fetch in parallel via React Query / SWR / RSC.

```tsx
// ✅ Correct — each section fetches its own data in parallel
export function DashboardOverview() {
  return (
    <div>
      <ExperimentsSection />     {/* independent */}
      <ActiveTrainingSection />  {/* independent */}
      <RecentActivitySection />  {/* independent */}
    </div>
  )
}
```

## State Management

**Applies to**: Client-side state that isn't server data.

**Rule**: Use Zustand stores in `src/stores/`. One store per domain.
For server data, use React Query (`@tanstack/react-query`).

```tsx
// src/stores/useUserStore.ts
import { create } from 'zustand'

interface UserState {
  currentUser: User | null
  setUser: (user: User) => void
  logout: () => void
}

export const useUserStore = create<UserState>((set) => ({
  currentUser: null,
  setUser: (user) => set({ currentUser: user }),
  logout: () => set({ currentUser: null }),
}))
```

## Related rules

- `nextjs.md` (server components by default, push client to leaves,
  no mounted flag)
- `api.md` (zod-validated inputs to client-side handlers)
- `error-handling.md` (no empty catch)

## Machine-readable patterns

```yaml
- id: react-no-class-component
  severity: high
  diff_regex:
    - "^class\\s+[A-Z]\\w*\\s+extends\\s+(React\\.)?Component\\b"
    - "^class\\s+[A-Z]\\w*\\s+extends\\s+React\\.PureComponent\\b"
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\bclass\\s+component\\b"
    - "(?i)\\bextends\\s+Component\\b"
  suggestion: "Use functional components with hooks. Never use class components. See .factory/rules/react.md."
  citations:
    - "https://react.dev/reference/react/Component"
- id: react-no-default-export
  severity: low
  diff_regex:
    - "^export\\s+default\\s+(function|class|const)\\s+"
  exclude_paths:
    - "page\\.tsx$"
    - "layout\\.tsx$"
    - "template\\.tsx$"
    - "loading\\.tsx$"
    - "not-found\\.tsx$"
    - "error\\.tsx$"
    - "global-error\\.tsx$"
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex: []
  suggestion: "Use named exports for better refactoring and import clarity. Page components are an exception (Next.js requires default). See .factory/rules/react.md."
  citations:
    - "https://developer.mozilla.org/en-US/docs/web/javascript/reference/statements/export"
- id: react-no-derivable-usestate
  severity: medium
  diff_regex:
    - "useState\\s*\\("
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\buseState\\b.*\\.filter\\("
    - "(?i)\\buseState\\b.*\\.map\\("
    - "(?i)\\buseState\\b.*\\.sort\\("
  suggestion: "If a useState value is a function of a prop or other state, use useMemo or compute inline. Storing derivable values invites drift. See .factory/rules/react.md."
  citations:
    - "https://react.dev/reference/react/useMemo"
- id: react-no-router-wrapper
  severity: medium
  diff_regex:
    - "^export\\s+(default\\s+)?function\\s+[A-Z]\\w*\\s*\\("
  exclude_paths:
    - "\\.test\\."
    - "\\.spec\\."
  prompt_regex:
    - "(?i)\\b(router\\s+wrapper|conditional\\s+component|switching\\s+component)\\b"
    - "(?i)\\bif\\s*\\([^)]*\\)\\s*return\\s+<[A-Z]\\w*\\s*/>\\s*;\\s*return\\s+<[A-Z]\\w*\\s*/>\\s*;"
  suggestion: "A component whose sole job is to choose between two siblings is a router wrapper. Branch at the call site (the server page). See .factory/rules/react.md."
  citations:
    - "https://react.dev/learn/conditional-rendering"
```

### Observed (auto-logged)
- 2026-06-16 22:18 — `apps/admin/src/components/organizations-table.tsx:98` — const [searchInput, setSearchInput] = useState(filters.q)
- 2026-06-16 22:18 — `apps/admin/src/hooks/use-debounced-value.ts:12` — const [debounced, setDebounced] = useState(value)
- 2026-06-16 22:41 — `apps/admin/src/components/slow-load-hint.tsx:11` — const [show, setShow] = useState(false)
- 2026-06-16 22:41 — `apps/admin/src/components/slow-load-hint.tsx:10` — export function SlowLoadHint() {
