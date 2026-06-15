# next-base

Next.js 16 (App Router) project layout. Wraps `npx create-next-app` and pins the project's tsconfig and ESLint to baka-compatible defaults.

## Actions

### `scaffold`

Create a fresh Next.js 16 project in the target directory. Idempotent.

**Parameters:**

- `name` (string): Project name (kebab-case).
- `tailwind` (boolean, optional): Install Tailwind CSS (default true).
- `srcDir` (boolean, optional): Use a `src/` directory (default true).

### `add-route`

Add a new App Router route (app/<segment>/page.tsx) with a default server component.

**Parameters:**

- `path` (string): Route path relative to app/ (e.g. 'dashboard/settings').
