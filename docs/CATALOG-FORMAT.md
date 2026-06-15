# Baka Catalog Format

This document describes the format a community maintainer ships to publish a catalog of baka modules to the marketplace.

A **catalog** is a single JSON document hosted at any HTTPS-accessible URL. The baka marketplace backend fetches the URL, validates the document against a Zod schema, and serves the result to consumers (the landing app, the baka CLI, third-party tools).

The marketplace never hosts module content. The `source` field on each module points to git/npm/local — install always goes through the existing `baka install <source>` path.

## Why a catalog at all

A catalog is a single file that lets you publish any number of related modules under one URL. The baka project's own first-party modules are published as a built-in catalog (`apps/api/src/data/built-in.json` in this repo). The same format is available to the community: maintain a JSON file in your own git repo, host it on GitHub Pages, on a CDN, or on any static host.

## Top-level shape

```jsonc
{
  "$schema": "https://baka.foo/schemas/catalog.v1.json",  // optional, for editor autocomplete
  "name": "acme-catalog",                                 // kebab-case, unique within the marketplace
  "version": "1.0.0",                                     // catalog's own version
  "description": "Acme's baka modules",
  "owner": { "name": "Acme", "email": "ops@acme.com" },
  "homepage": "https://github.com/acme/baka-catalog",     // optional
  "modules": [ /* ModuleEntry, see below */ ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `$schema` | string | no | URL of the JSON Schema for editor autocomplete |
| `name` | string | yes | kebab-case (lowercase, digits, hyphens). Unique within the marketplace. |
| `version` | string | yes | Semver of the catalog itself (NOT the modules). |
| `description` | string | no | Short description of the catalog. |
| `owner` | object | yes | `{ name, email? }`. Used for attribution. |
| `homepage` | URL | no | Where users can learn more about your catalog. |
| `modules` | array | no | Default: `[]`. You can publish a "shell" catalog first and add modules later. |

## Module entries

Each module in the `modules` array is the baka manifest (the same one that lives in `<module>/manifest.ts`) plus marketplace-specific fields.

```jsonc
{
  // baka manifest fields — see docs/MODULES.md for the full schema
  "name": "baka-acme-auth",
  "version": "1.0.0",
  "description": "Acme-flavored Better-Auth setup",
  "dependencies": [],
  "conflictsWith": [],
  "actions": [
    {
      "id": "install",
      "description": "Install Better-Auth with Acme defaults",
      "params": [],
      "requiresReasoning": false,
      "filePatterns": ["auth.ts"],
      "validators": []
    }
  ],
  "moduleValidators": [],

  // Marketplace-specific fields
  "source": "git:github.com/acme/baka-acme-auth@v1.0.0",
  "author": { "name": "Acme" },
  "license": "MIT",
  "homepage": "https://github.com/acme/baka-acme-auth",
  "tags": ["auth", "next", "better-auth"],
  "category": "auth",
  "keywords": ["authentication", "session"],

  // Visual metadata (optional, minimal)
  "icon": "https://acme.com/baka-acme-auth.svg",
  "accent": "#F5E6A8"
}
```

### `source` — the install truth

The `source` field reuses the existing baka source-string format:

| Prefix | Example | What it does |
|---|---|---|
| `npm:` | `npm:@acme/baka-auth@^1.0.0` | `npm pack` + extract |
| `git:` | `git:github.com/acme/baka-auth@v1.0.0` | `git clone --branch v1.0.0` |
| `https://` / `ssh://` | `https://gitlab.com/acme/baka-auth.git` | `git clone` |
| `/abs/path` or `./rel/path` | `/srv/modules/baka-auth` | local copy / symlink |

The marketplace does no transformation. Whatever you put here is what `baka install` will run. **The `source` is the install truth, not the baka manifest inside the catalog.** They can drift; the marketplace backend doesn't try to keep them in sync.

### Visual metadata

Two optional fields, both nullable. The landing app applies silver/gray text, black card backgrounds, and light-yellow (`#F5E6A8`) accents by default. Per-module overrides only change the inside of that module's card.

| Field | Type | Default | Notes |
|---|---|---|---|
| `icon` | URL or data-URI | Yellow square with first letter of module name | Used as a 64x64 card thumbnail. |
| `accent` | hex color (`#RGB`, `#RRGGBB`, or `#RRGGBBAA`) | `#F5E6A8` (light yellow) | Used for tags, badges, hover state inside this module's card. |

Keep it minimal. Visual fluff is the thing this marketplace explicitly rejects.

## Trust tiers

When the marketplace serves a module, it attaches a `tier` field based on **where the catalog came from**, not what the catalog claims. Publishers cannot self-declare `built-in` or `verified`.

| Tier | How a module gets it |
|---|---|
| `built-in` | The catalog is `apps/api/src/data/built-in.json` in the baka repo. |
| `verified` | The catalog URL is in `apps/api/src/data/verified.json` in the baka repo. |
| `community` | The user subscribed to the catalog via `baka marketplace add <url>`. |

The landing app defaults to `built-in` + `verified` and surfaces `community` only in a separate "Your catalogs" section. This is the explicit fix for the "noisy marketplace" problem — the noise is opt-in.

## Getting a catalog verified

1. Publish your catalog at a stable HTTPS URL.
2. Open a PR against the baka repo that adds an entry to `apps/api/src/data/verified.json`:
   ```json
   {
     "url": "https://acme.com/baka-catalog.json",
     "name": "Acme's catalog",
     "description": "...",
     "addedAt": "2026-06-15"
   }
   ```
3. CI fetches your URL, validates the response, and rejects the PR if the catalog is malformed or unreachable.
4. Once merged, your catalog appears in the landing app's "Verified" section.

Maintainers review PRs on the merits: code quality of the modules, license clarity, attribution honesty.

## Publishing the first-party catalog (baka maintainers)

First-party modules are added to `apps/api/src/data/built-in.json` by PR. CI validates the file against the Zod schema and rejects PRs that introduce malformed entries. The marketplace backend attaches `tier: "built-in"` to every module in this file.

For v1, the built-in catalog is hand-maintained. A future CI step (out of scope) could generate it from `modules/*/manifest.ts` to prevent drift.

## Hosting options

The catalog is a static JSON file. Any HTTPS URL works. Common options:

- **GitHub Pages** — commit `catalog.json` to `gh-pages` branch, point users at `https://<org>.github.io/<repo>/catalog.json`.
- **Raw GitHub URL** — `https://raw.githubusercontent.com/<org>/<repo>/main/catalog.json`. Works but isn't ideal because the URL changes if you rename the branch.
- **S3 / R2 / GCS** — `https://<bucket>.s3.amazonaws.com/catalog.json`. CDN-friendly.
- **Your own server** — any web server that serves JSON over HTTPS.

Make sure the URL is **stable**: users will type it into `baka marketplace add <url>` and breaking it is a breaking change.

## Validation

To validate your catalog locally before publishing, run the API package's tests against your file. The schema lives in `apps/api/src/lib/schema.ts`. You can also point a small script at it:

```ts
import { CatalogSchema } from "@baka/api/schema"
import catalog from "./catalog.json"

const result = CatalogSchema.safeParse(catalog)
if (!result.success) {
  console.error(result.error.issues)
  process.exit(1)
}
console.log("catalog is valid")
```

## What this format is not

- **Not a module registry.** The marketplace never hosts module tarballs. Install goes through git/npm.
- **Not a package manager.** The `source` field reuses the existing source-string format. If you need a new transport, propose it to the baka engine first.
- **Not a sandboxed execution environment.** Modules you install run code on the user's machine. Tier filters help users opt into the level of trust they want; they don't replace review.
