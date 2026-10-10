# packs/

`starter/` is the pack Baka ships with: small, deterministic recipes that need no model
(`baka run add-readme --name my-app`). It is the one pack bundled with an install.

Everything else is a pack you install or write in a **project**:

- `<project>/packs/<name>/`
- `<project>/.baka/packs/<name>/`
- `$BAKA_HOME/packs/<name>/`

The engine materializes `templates/` (params + named slots). Tests in this
repo use tiny fixtures under `apps/cli/test/fixtures/`.
