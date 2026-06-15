# ts-style

TypeScript style enforcer. Bundles validators that block `any`, warn on `console.log`, and require explicit return types on exported functions.

## Actions

### `install-config`

Drop a strict tsconfig.json and biome.json into the target project.

**Parameters:**

- `strict` (boolean, optional): Apply maximum strictness (default true).

### `lint`

Run the project's linter (biome) and report findings. Stub for Phase 6; full impl wires the validator chain in Phase 8.

**Parameters:** (none)
