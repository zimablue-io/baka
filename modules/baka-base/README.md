# baka-base

Minimal hello-world TypeScript project scaffold. Use this as the foundation for any new app.

## Actions

### `scaffold`

Create a fresh TypeScript project (package.json, tsconfig.json, src/index.ts, README.md).

**Parameters:**

- `name` (string): Project name (kebab-case).
- `description` (string, optional): Short project description.
- `moduleType` (enum, optional): Module system. (esm, commonjs)

### `add-script`

Add or update a script entry in package.json. Idempotent.

**Parameters:**

- `name` (string): Script name (e.g. 'build').
- `command` (string): Script command (e.g. 'tsc').

### `add-dependency`

Add a runtime or dev dependency to package.json with a pinned version range.

**Parameters:**

- `name` (string): Package name (e.g. 'zod').
- `version` (string): Version range (e.g. '^3.23.0').
- `dev` (boolean, optional): Add to devDependencies (default false).
