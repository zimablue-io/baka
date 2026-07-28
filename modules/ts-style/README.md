# ts-style

TypeScript style enforcer. Bundles validators that block `any`, warn on `console.log`, and require explicit return types on exported functions.

## Actions

### `install-config`

Drop a strict tsconfig.json and biome.json into the target project.

**Parameters:**

- `strict` (boolean, optional): Apply maximum strictness (default true).

### `lint`

Lint the current project with biome and report every diagnostic (file, rule, severity, message, position). Requires a biome configuration in the project (`install-config` provides one); uses the project's own biome when installed, otherwise the copy bundled with ts-style.

**Parameters:** (none)
