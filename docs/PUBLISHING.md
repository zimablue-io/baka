# Publishing baka

Baka is distributed in two places and nowhere else: the install site and GitHub releases. It is not on npm, and nothing in this repository publishes there. The packages carry `@baka` names so they have one identity everywhere (`@baka/cli`, `@baka/core`, ...), but a name only matters to npm once something is published; installing from a tarball needs no registry and no scope.

## The install site

The dashboard deployment (`apps/dashboard`, Vercel project `baka-dashboard`, https://baka.dashboard.zimablue.io) also serves the install. Its build runs `pnpm run site`, which builds every package, packs one tarball per published package and stages them with `install.sh` and a sha256 manifest under `/releases/` (`scripts/stage-site.mjs`).

```sh
curl -fsSL https://baka.dashboard.zimablue.io/install.sh | sh
```

installs from it with no clone and no build, and ends on the handshake. `/releases/latest/` always holds the newest version and `/releases/v<version>/` keeps each one. For a library embed: `npm install https://baka.dashboard.zimablue.io/releases/latest/baka-core.tgz` (its `@baka/protocol` dependency resolves from the same release).

A push that touches nothing the build uses is skipped (`ignoreCommand` in `apps/dashboard/vercel.json`), so a path the site build starts reading belongs in that list. The site is public and has no gate: it serves the build, the licenses inside it, and nothing else.

## GitHub releases

Pushing a tag `v<version>` runs `.github/workflows/release.yml`: it checks the tag equals the version in `package.json`, builds, packs (the tarballs name each other by the release's download URL), runs `verify:core` and `verify:cli`, and creates a GitHub release with every package's tarball (versioned and unversioned names), `install.sh` and `moralo.module.json`. Someone installing from a release needs the repository and its assets to be reachable, so while the repository is private the site is the install.

## Cutting a release

1. `scripts/release.sh <version>` (clean tree only; `--dry-run` shows the plan) bumps the root and the five published packages, builds, and packs into `dist-tarballs/`. It never publishes.
2. `apps/cli/test/version-sync.test.ts` fails if a published package's version drifts from the root.
3. Check the tarballs: `tar -tzf dist-tarballs/baka-<name>-<version>.tgz` lists `package/package.json`, `package/dist/index.js`, `package/README.md`, `package/LICENSE` and `package/NOTICE`, and, for the CLI and MCP bundles, `package/THIRD-PARTY-NOTICES.md`. It lists no `.env*`, `.git`, `node_modules`, `coverage`, `test` or `src`.
4. `pnpm run verify:core` and `pnpm run verify:cli` install the tarballs into a scratch project outside the workspace and exercise them.
5. Commit, push to `main` (the site redeploys), then tag: `git tag v<version> && git push origin v<version>`.
6. Add the dated entry to `CHANGELOG.md`. If the contract changed, bump the version in `packages/protocol/src/contract.ts` and add its changelog entry in the same commit.

`pnpm run pack -- --dep-base semver` writes `^<version>` dependencies between the tarballs instead of URLs. Nothing uses it today; it is there for the day Baka goes to a registry.

## Licenses in the tarballs

Every published package carries `LICENSE` (Apache-2.0) and `NOTICE`. A package whose bundle inlines npm code (today the CLI and MCP bundles: hono, handlebars, zod and their kin) also carries `THIRD-PARTY-NOTICES.md`, written at pack time by `scripts/third-party-notices.mjs` from the sourcemaps, with each project's own license text. Dependencies that npm installs next to the package keep their own license files. The dependency tree is permissive licenses only (MIT, ISC, BSD, Apache-2.0, 0BSD); a new dependency under a copyleft license needs a decision before it lands.

What is not settled by code: the legal entity and contact address in `TRADEMARKS.md` and `COMMERCIAL.md`, and counsel's reading of the contributor agreement. Those texts say so on their first line.
