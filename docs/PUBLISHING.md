# Publishing baka to npm

This document is the runbook for the npm switch. It is intentionally NOT automated — `scripts/release.sh` builds tarballs but never pushes them. Publishing is a manual follow-up the maintainer does once per release, after the tarball review and the version sanity checks.

The contract:

- `scripts/release.sh <version>` produces the tarballs and prints the install command.
- `scripts/release.sh` never calls `pnpm publish`.
- `docs/PUBLISHING.md` documents the publish step. Following this runbook is a maintainer action, not part of CI.
- The repo's `.github/workflows/ci.yml` has zero `pnpm publish` invocations. CI cannot accidentally publish.

## Preflight

Before publishing anything, walk this list. If any step fails, stop and fix the underlying cause. Do not push through a red light.

1. **Clean working tree.** `git status --porcelain` is empty. `scripts/release.sh` already refuses to run on a dirty tree, so reaching the publish step implies this passed.
2. **Manifest sanity.** `pnpm install --frozen-lockfile` completes without `--frozen-lockfile` errors. The lockfile is in sync with `package.json` for every workspace.
3. **Version match.** The version in root `package.json`, `apps/cli/package.json`, and `apps/mcp/package.json` all read `<version>`. The release script enforces this — if any one drifted, the bump step would have failed. Spot-check with:
   ```bash
   jq -r .version package.json apps/cli/package.json apps/mcp/package.json
   ```
   The output must be three lines, all identical.
4. **CI green.** `gh pr checks --watch` (or the Actions tab) shows lint, type-check, test, build, pack, and the smoke step all green on the release commit. The PR template and `CONTRIBUTING.md` agree that failing CI blocks merge; do not publish over a red build.
5. **Tarball review.** `dist-tarballs/` contains `baka-<version>.tgz` and `@baka-mcp-server-<version>.tgz`. Inspect both:
   ```bash
   tar -tzf dist-tarballs/baka-<version>.tgz | head -40
   tar -tzf dist-tarballs/@baka-mcp-server-<version>.tgz | head -40
   ```
   Each lists `package/`, `package/package.json`, `package/dist/index.js`, `package/README.md`, `package/LICENSE`. None of them lists `package/.env*`, `package/.git`, `package/node_modules`, `package/coverage`, `package/test`, or `package/src`. If anything leaks, fix `package.json` `files` field or `.npmignore` and rebuild the tarball.
6. **Local install smoke.** Install both tarballs into a fresh `mktemp -d` and run the documented smoke sequence:
   ```bash
   SCRATCH=$(mktemp -d)
   cd "$SCRATCH"
   pnpm install -g /abs/path/to/baka-<version>.tgz
   pnpm install -g /abs/path/to/@baka-mcp-server-<version>.tgz
   which baka; which baka-mcp
   baka --version
   baka list-modules --json | jq '.modules | length'   # expect 3
   ```
   If `baka --version` does not print `<version>`, stop. The tarball was built wrong.

## npm login

Publishing requires an authenticated npm session. The maintainer who owns the `@baka` scope runs `npm login` interactively from a workstation with browser access.

```bash
npm login
# Browser opens; complete 2FA. Verify with:
npm whoami
npm access ls-packages @baka   # confirms scope access
```

Use a fresh login session for each release. Stale `~/.npmrc` tokens can leak across accounts.

If you publish from CI, configure the `NPM_TOKEN` secret in the GitHub repository settings and reuse it via `npm config set //registry.npmjs.org/:_authToken "$NPM_TOKEN"`. **Do not** add a `pnpm publish` step to `.github/workflows/ci.yml` — that would flip the switch automatically, which this mission does not authorize.

## Dry-run

Always dry-run the publish command before the real publish. `pnpm publish --dry-run` builds the tarball again, prints the manifest it would upload, and stops before the network round-trip. It catches tag and dependency surprises without leaving a published version behind.

```bash
pnpm publish --filter baka --filter @baka/mcp-server --no-git-checks --dry-run
```

Read the manifest dump carefully. Confirm:

- `name`, `version`, `description`, `license`, `repository`, and `bin` fields match the upstream `package.json`.
- `dependencies` lists only external packages (no `@repo/*`, no `@baka/*`, no `baka-sdk` — those were bundled into the dist by tsup).
- `files` includes `dist`, `README.md`, `LICENSE` and nothing else.
- The package is **not** marked `private: true`. `scripts/pack.mjs` strips the `private` flag from the published manifest for the duration of the pack; the dry-run confirms the strip succeeded.

A dry-run that shows the wrong manifest is a release-blocking bug. Do not push to the registry; fix the pack wrapper or the source `package.json` and start over.

## Publish

When the dry-run output is exactly what the registry should receive, run the real publish. There is no `--dry-run` flag, no `--tag`, no `--access public` override; the workspace is configured for public access and the default tag is `latest`.

```bash
pnpm publish --filter baka --filter @baka/mcp-server --no-git-checks
```

`--no-git-checks` is intentional: `pnpm publish` would otherwise refuse if your working tree is not on the published git tag. We tag after publishing (see below), not before, so the working tree is one commit ahead of the tag. This is the same pattern npm uses for first-time publishes.

The two workspace filters run in dependency order. The CLI (`baka`) and the MCP server (`@baka/mcp-server`) are independent — neither depends on the other — so the order does not matter, but `pnpm publish` still enforces a deterministic sequence.

Watch the output for any non-zero exit code or unexpected warning. A successful publish prints `+ baka@<version>` and `+ @baka/mcp-server@<version>` and exits 0.

## Post-publish verification

1. **Tag the commit.** The release bump and pack happened on `main`; the publish is the last step. Tag the commit that contains the bumped versions:
   ```bash
   git tag -a v<version> -m "release: baka v<version>"
   git push origin v<version>
   ```
   `--no-git-checks` on the publish step means the tag is post-hoc; that is by design.
2. **Install from the registry.** In a clean `mktemp -d`, install from npm instead of the local tarballs:
   ```bash
   SCRATCH=$(mktemp -d)
   cd "$SCRATCH"
   npm install -g baka@<version>
   npm install -g @baka/mcp-server@<version>
   which baka; which baka-mcp
   baka --version
   ```
   `baka --version` must print `<version>`. If it prints anything else, the published manifest has the wrong version — yank with `npm unpublish` and start over.
3. **Update CHANGELOG.md.** Add a dated entry under `## [<version>] - <date>` summarizing the release. Keep entries short (one line per change); the git log is the canonical history.
4. **Announce.** Push the tag and let CI pick it up for the GitHub release notes. If you maintain a Discord or Slack channel for the project, drop a one-liner with the install command.

## Rollback

If the publish is broken (wrong version, wrong dependency, corrupt tarball) and was published within the last 72 hours, npm allows `npm unpublish`. After 72 hours, deprecate instead:

```bash
npm deprecate baka@<bad-version> "broken release; use <good-version> instead"
npm deprecate @baka/mcp-server@<bad-version> "broken release; use <good-version> instead"
```

Then cut a patch release (e.g. `0.2.0` → `0.2.1`) that fixes the underlying cause. Do not try to overwrite the published version — npm does not allow republishing a version, even with `--force`.

## Why this is a separate step

`scripts/release.sh` is the canonical release tool. It runs every step that should be automated: the version bump across the three package.json files, the dist rebuild, the pack, the install-command print. What it does NOT do is push to a registry. The reason is safety:

- Publishing is irreversible on the order of minutes-to-hours (`npm unpublish` is rate-limited and disabled for packages with dependents).
- It requires human judgment (version sanity, manifest review, dependency sanity) that does not belong in a script.
- It requires an authenticated npm session that does not belong in CI.

The split keeps the automated path hermetic and the manual path observable. The CI workflow cannot accidentally publish because there is no `pnpm publish` step anywhere in `.github/workflows/`.

If a future maintainer wants to flip the switch and add a CI-driven publish step, that is a deliberate, reviewable change to `.github/workflows/ci.yml` and `scripts/release.sh`. It is not done in this mission.
