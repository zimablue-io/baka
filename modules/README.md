# modules/

Baka does not ship example modules as the product.

Install or author a module in a **project**:

- `<project>/modules/<name>/`
- `<project>/.baka/modules/<name>/`
- `$BAKA_HOME/modules/<name>/`

The engine materializes `templates/` (params + named slots). Tests in this
repo use tiny fixtures under `apps/cli/test/fixtures/`, not this folder.
