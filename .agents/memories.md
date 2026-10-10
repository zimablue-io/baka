# Project Memory

Short, hand-curated facts the model should keep in mind on every session.
Real rules live in `.agents/rules/`. This file is the index + project-specific
nuggets that don't deserve a full rule file.

Cross-project personal memory lives in your agent harness's own memory
file and is injected automatically on session start.

## Active Constraints

See `.agents/rules/` for the canonical rules. This file only adds
project-specific constraints that don't yet deserve a full rule file.

- **2026-10-10: Commit messages carry NO agent co-author trailer.**
  The global hook `/Users/lefamoffat/.config/git/hooks/commit-msg-policy`
  rejects any message naming an agent (claude, anthropic.com, cursor,
  copilot, chatgpt, gemini, factory-droid, `[bot]`, and more). It fires on
  both the `Co-Authored-By:` trailer and "Generated with ..." signature
  lines. This overrides the usual `Co-authored-by: factory-droid[bot]`
  convention. History still shows `Claude Sonnet 5.5` trailers on older
  commits, so the policy is newer than them. Keep the subject imperative
  and the body to one short paragraph.

- **2026-08-26: The usable project is `demo/`.** Packs live in
  the consumer tree (`demo/packs/`): `vite-app`, `vite-theme`,
  `vite-page`. They write a Vite + TypeScript app. Dashboard
  project folder = absolute path to `demo/`. Do not restore
  deleted first-party catalog packs.
  **2026-10-10 exception, deliberate:** `packs/starter/` is the one
  pack that ships inside the install (CLI and MCP `dist/packs/`). It is a
  small, model-free set of everyday recipes (`add-readme`, `add-gitignore`,
  ...) so the first run works with no setup. It is searched after every
  other scope, so a project or user pack of the same name replaces it, and
  it is absent when `--packs-dir` / `BAKA_PACK_DIRS` is given. Anything
  larger belongs on the hub, not here.

- **2026-08-25: Do not nibble-rename catalog tests.** If a suite
  still encodes a deleted catalog pack (`scaffold`, bundled
  discovery), delete it and write a platform test against
  `apps/cli/test/fixtures/` or the registry `hello` fixture.
  Search `"base"` + expect `"scaffold"` after a name swap is the
  failure mode.

- Hooks are not configured in this repo. Formatting and the
  format/lint/test gates come from your own agent harness.

- **Port 8080 is the user's llama-server (off-limits).** AGENTS.md and
  `services.yaml` both call it out: never start, stop, kill, or check its
  presence/absence. Validators that look for orphan processes via `lsof -ti:8080`
  must NOT escalate to a `kill -9` against the resulting PID — that PID
  belongs to the user's shared llama-server. The only allowed read interaction
  is the healthcheck URL `curl -sf http://127.0.0.1:8080/v1/models`. Validators
  that find leftover fake-LLM helper servers (the 127.0.0.1:0 ephemeral ports
  ephemeral-bound, normal-close-on-handle) must use process-tree inspection
  (parent process, command name `node`, vs the launcher) to distinguish them
  from the shared llama-server which uses port 8080 statically. Recorded
  2026-08-06 after a user-testing-validator session mistakenly used
  `lsof -ti:8080` to find orphan processes and `kill -9`'d the user's
  llama-server. (Auto-restart may have recovered; not retested in this session.)

- **2026-08-06: Sequence edits to the same file.** A parallel tool batch may
  target each file at most once; dependent edits to one file run in separate
  batches so neither replacement races the other.

- **2026-08-07 (HARD): NEVER modify global git identity.** A mission worker
  set `git config --global user.name/user.email` to a fixture identity
  (`baka-fixture <fixture@baka.local>`), poisoning attribution on ~100
  commits across four repos before it was caught. Restored to
  `Lefa Moffat <lefakmoffat@gmail.com>`. Global/system git config and
  `~/.gitconfig` are user-owned state — read-only to agents. Fixture/test
  identity is repo-local only, inside throwaway fixture dirs
  (`git -C <dir> config ...`, as `apps/registry/test/git-fixture.ts` does
  correctly). If git refuses to commit for lack of identity, escalate —
  never set one.

## Known Stale Knowledge

<!-- Add project-specific "training-data is wrong, the actual state is X"
     entries here. -->

## Past Decisions

- 2026-08-25: Slot-native templates. Files are Handlebars with named `{{#slot}}` holes; `gemma4:e4b` (served id `gemma4-e4b`, alias `gemma4:e4b`) is the intelligence floor. Hono `apps/engine` is the tool SSOT (`app.request()`, no CLI daemon). Planner is demoted. MCP has no per-recipe tools. Spec: `docs/superpowers/specs/2026-08-25-slot-native-templates.md`.

- 2026-08-25: `POST /v1/run` sets `validate: false`. Named run writes the tree; `baka validate` / `POST /v1/validate` is the separate gate. Default `runNamedRecipe` still validates, which pulls structural diagnostics from every discovered pack (including broken `$BAKA_HOME` marketplace copies).

- 2026-08-25: `baka serve` CORS allows `localhost` / `127.0.0.1` origins so the dashboard (TanStack Start at `127.0.0.1:1420`) can call `http://127.0.0.1:4311`. CLI `app.request()` is same-origin and does not need that header.

- 2026-08-25: The product UI is `apps/dashboard` (TanStack Start + shadcn/ui with `base` / `@base-ui/react`). SPA prerender to `index.html`, `frontendDist` is `dist/client`, `devUrl` is `127.0.0.1:1420`. Toasts use Base UI `toast.add`, not Sonner. No second file-writer.

- 2026-08-25: Baka is one app. The user listed three surfaces (agent CLI, human desktop, marketplace), never "three products". That phrase was assistant-invented plan titling. Do not use it.

- 2026-08-25: Desktop job (user): run experiments, manage packs, nice GUI, for humans, show the templating system. Shipped "baka lab" (JSON, N× hashes, kebab ids) is wrong. Clicking a pack does not even load that recipe's param schema.

- 2026-08-25: Baka is a pack **platform**. First-party example packs (baka-base, sdd, ts-style) are deleted, not the product. Next.js is a future pack, not the architecture. Bundled discovery no longer walks the git repo into every package.json cwd. Desktop lists whatever is installed in the chosen project. Tests use tiny fixtures. A CLI happy-path e2e is one test among many, not a branded "pretend-user" product.

- 2026-08-25: Do not invent product names ("three products", "pretend-user CLI flow"). Say what the code does.

- 2026-08-06 user-testing-validator (foundation-fix milestone): the validator
  ran five parallel flow-validator subagents (a user-testing-flow-validator
  custom droid). Three returned "Subagent session reported an error" but
  actually wrote substantial evidence + flow JSONs to disk before erroring.
  Future validators should rely on the on-disk artifacts themselves, not
  on the harness's session-status, when partial work is acceptable — a
  session-error rcode does not imply zero work was produced.

