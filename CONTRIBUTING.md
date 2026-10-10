# Contributing to baka

Thanks for your interest in contributing. Baka is a deterministic pack-recipe engine for LLM-assisted development, and contributions of all sizes are welcome.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you agree to its terms.

## Contributor License Agreement

> Draft text, awaiting legal review before the first public release.

Baka is open source under the [Apache License 2.0](./LICENSE), and the owner also sells paid options built around it (see [COMMERCIAL.md](./COMMERCIAL.md)). So that the owner can license every contribution both ways, each outside contribution comes under this agreement. It is the same for every contributor and is needed from the first one.

By submitting a contribution (a pull request, a patch, or anything else sent for inclusion), you, the contributor, agree that:

1. **You wrote it, or may submit it.** The contribution is your original work, or you have the right to submit it under these terms, and your employer, if any, does not object.
2. **Copyright license.** You grant Zima Blue (the owner) and everyone who receives Baka a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to reproduce, prepare derivative works of, publicly display, publicly perform, sublicense and distribute your contribution and such derivative works.
3. **Relicensing.** You also agree that the owner may license your contribution under any other terms, including commercial terms and a different open-source license, for any version of Baka or of its paid options. You keep the copyright in your contribution.
4. **Patent license.** You grant the owner and every recipient a perpetual, worldwide, non-exclusive, royalty-free, irrevocable patent license to make, use, sell, offer to sell, import and otherwise transfer your contribution, limited to the patent claims you can license that are necessarily infringed by it alone or with the work it was submitted to.
5. **No warranty.** You provide the contribution as is, with no warranty or obligation to support it.

To agree, put this line in the description of every pull request, unchanged:

```
I have read and agree to the Contributor License Agreement in CONTRIBUTING.md.
```

The `CLA` check on pull requests fails until the line is there. Authors listed in `.github/cla-exempt.txt` (the owner and automation) do not need it.

## Reporting security issues

Please do not open public issues for security vulnerabilities. Follow the [Security policy](./SECURITY.md) instead.

## Development setup

**Requirements**

- Node.js v24 or later
- pnpm v9 or later (the repo pins `pnpm@9.0.0` via `packageManager`)

**Clone and install**

```bash
git clone https://github.com/zimablue/baka.git
cd baka
pnpm install
```

The postinstall hook builds the `baka` CLI. After install you can invoke it with `pnpm baka <command>`.

**Useful scripts**

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run all apps in watch mode via Turborepo |
| `pnpm build` | Build every workspace package |
| `pnpm lint` | Run `biome check` across the repo |
| `pnpm check-types` | Type-check every workspace |
| `pnpm test` | Run the full Vitest suite |
| `pnpm pack` | Build installable tarballs for `baka`, `@baka/mcp-server`, and `@baka/core` into `dist-tarballs/` |
| `pnpm format` | Run Biome's auto-formatter (`biome format --write .`) |
| `pnpm knip` | Run the strict unused file, export, and dependency gate |
| `pnpm baka plan "<intent>"` | Plan a feature using the engine |
| `pnpm baka scaffold <pack>` | Scaffold a new pack |

## Project layout

- `apps/cli` — the `baka` binary
- `apps/mcp` — the `baka-mcp` MCP server
- `apps/registry` — the self-hostable OSS pack registry (the public hub)
- `apps/landing` — the marketing site
- `packages/protocol` — single source of truth for types and schemas
- `packages/agent-engine` — the only package that knows what an `LLMProvider` is
- `packages/ast-tooling` — file/AST operations
- `packages/core` — `@baka/core`, the published embeddable library (runRecipe, validate, describePacks)
- `packages/baka-sdk` — public SDK for pack authors
- `packages/typescript-config` — shared TypeScript configs
- `workflows/` — engine orchestration for this project
- `packs/` — user-defined patterns (recipe-centric layout)

The provider boundary is enforced: only `packages/agent-engine` may import a provider, HTTP client, or model name. See `docs/PHILOSOPHY.md` for the full invariant.

## Pull request process

1. **Open an issue first** for non-trivial changes so we can agree on direction.
2. **Fork and branch** from `main`. Use a descriptive branch name (`feat/...`, `fix/...`, `chore/...`).
3. **Keep PRs focused.** One concern per PR. Large refactors should be split.
4. **Run the full validation locally before pushing:**

   ```bash
   pnpm lint
   pnpm check-types
   pnpm test
   pnpm knip
   ```

5. **Fill out the PR template.** Include the rationale, the test plan, and a link to the tracking issue.
6. **CI must be green before merge.** Every PR runs lint, type-check, test, build,
   pack, Knip, and the smoke step (linked-binary probe of `baka` and `baka-mcp`) on
   GitHub Recipes. A failing CI run blocks merge: do not bypass the required
   status checks or push commits that skip the workflow. The PR template
   mirrors CI; reviewers will wait for it. If a CI failure is unrelated to your
   change, fix the underlying cause in a separate PR rather than merging a red
   build.

## Commit message format

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

<optional body explaining the why>

<optional footer>
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `build`, `ci`. Scopes map to workspace names when relevant: `cli`, `mcp`, `api`, `protocol`, `agent-engine`, `ast-tooling`, `baka-sdk`.

## Coding standards

- TypeScript everywhere. No `any` in new code.
- Lint and format with Biome (`pnpm lint`, `pnpm format`).
- Match the surrounding code style. Read the file before editing it.
- Add tests for new behavior. Bug fixes include a regression test.
- Do not bypass the provider boundary. The grep test in `docs/PHILOSOPHY.md` must pass.

## Adding a new pack

Packs are recipe-centric. Author one with the double-diamond flow:

```bash
pnpm baka pack create <name>
```

The CLI handles manifest, recipes, validators, templates, and `PREFERENCES.md`. Hand-writing manifests is discouraged — the design tool enforces a 5x consistency test before delivery.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
