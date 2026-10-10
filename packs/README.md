# packs/

Baka does not ship example packs as the product.

Install or author a pack in a **project**:

- `<project>/packs/<name>/`
- `<project>/.baka/packs/<name>/`
- `$BAKA_HOME/packs/<name>/`

The engine materializes `templates/` (params + named slots). Tests in this
repo use tiny fixtures under `apps/cli/test/fixtures/`, not this folder.
