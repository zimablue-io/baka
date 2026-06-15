# Contributing to baka

Thanks for your interest in contributing. Baka is a deterministic module-action engine for LLM-assisted development, and contributions of all sizes are welcome.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you agree to its terms.

## Reporting security issues

Please do not open public issues for security vulnerabilities. Follow the [Security policy](./SECURITY.md) instead.

## Development setup

**Requirements**

- Node.js v20 or later
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
| `pnpm format` | Format with Prettier |
| `pnpm baka plan "<intent>"` | Plan a feature using the engine |
| `pnpm baka scaffold <module>` | Scaffold a new module |

## Project layout

- `apps/cli` — the `baka` binary
- `apps/mcp` — the `baka-mcp` MCP server
- `apps/api` — the public API
- `apps/landing` — the marketing site
- `packages/protocol` — single source of truth for types and schemas
- `packages/agent-engine` — the only package that knows what an `LLMProvider` is
- `packages/ast-tooling` — file/AST operations
- `packages/baka-sdk` — public SDK for module authors
- `packages/typescript-config` — shared TypeScript configs
- `workflows/` — engine orchestration for this project
- `modules/` — user-defined patterns (action-centric layout)

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
   ```

5. **Fill out the PR template.** Include the rationale, the test plan, and a link to the tracking issue.
6. **CI must be green.** The PR template mirrors CI; reviewers will wait for it.

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

## Adding a new module

Modules are action-centric. Author one with the double-diamond flow:

```bash
pnpm baka module create <name>
```

The CLI handles manifest, actions, validators, templates, and `PREFERENCES.md`. Hand-writing manifests is discouraged — the design tool enforces a 5x consistency test before delivery.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
