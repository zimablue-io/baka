# Baka is a pack platform

**Owner**: Platform
**Last Updated**: 2026-08-25
**Applies to**: the whole repo.

Baka is the engine, CLI, desktop, MCP, and registry. It is **not** a
Next.js app, not an SDD tool, and not a lint pack. A pack is a
well-formed manifest + templates (params + named slots) that the
engine can discover, preview, fill, write, and validate.

## Product bar

Any well-formed pack in a project must be usable:

1. Discover (`list-packs` / `GET /v1/packs`)
2. Inspect human fields and **template source** (`inspect` / `GET /v1/preview`)
3. Fill slots or let gemma fill them
4. Write into a **chosen project**
5. Same command + same params + same slot cache → same tree
6. Validate

The bar is ordinary tests plus a CLI happy-path e2e against
fixtures, plus a consumer-project e2e against `demo/packs`.
A subagent walking the same path is another test, not a product.

## Forbidden framing

- Treating Next.js (or any one stack) as the architecture
- Shipping first-party example packs (`baka-base`, `sdd`, `ts-style`,
  a Next.js pack) as the product catalog
- Hardcoding pack ids in the desktop or engine
- Walking the git checkout's `packs/` into every `package.json` cwd
- Using a complex framework as the first test flow

Next.js, South, AGENTS.md, Cache Components, etc. are **future
packs**. They may illustrate what a real pack looks like. They
are not this milestone.

## Tests

Tests copy fixtures from `apps/cli/test/fixtures/` (honest-mod,
slot-mod) into a temp project. They do not require a bundled catalog.
The built-in registry catalog is empty until a pack is actually
productized and published.

### Observed (auto-logged)

- 2026-08-25 — nibble-renaming baka-base→hello inside catalog
  suites left search `"base"` and recipe `"scaffold"`. Delete those
  suites; write against fixtures.
