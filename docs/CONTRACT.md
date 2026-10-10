# The Baka contract

**Contract version 1.1.0.** This page is what a host (a script, an agent, a CI job, another product such as Moralo) may rely on. Anything not written here may change without notice.

Baka stands on its own and knows nothing about its hosts. Everything below is reachable three ways with the same documents: the `baka` command, the HTTP service (`baka serve`) and the library (`@baka/core`). `baka-mcp` exposes the same engine as tools for an agent.

## Versioning

- The contract has a semver version (`1.1.0`). `baka version --json` reports it as `contract`.
- Every document has an id made of a name and the contract's **major** version: `baka.receipt/1`. Within a major, documents only gain optional fields and capabilities only gain names. A change that breaks a reader raises the major and every id with it.
- The tool has its own semver (`version`), released on its own line. The contract version is not the tool version.
- The changelog is at the end of this page.

## Install and first run

```bash
curl -fsSL https://github.com/zimablue-io/baka/releases/latest/download/install.sh | sh
baka run add-readme --name my-app        # in an empty directory: writes README.md; no model, no account
```

`install.sh` needs Node.js 24 or later and nothing else, asks nothing, and ends on the handshake (exit `3` when the install does not answer). `--version X.Y.Z` picks a release, `--tarball` installs a build you made, `--prefix DIR` keeps it out of the global npm directory. The release assets are `baka-<version>.tgz` (and `baka.tgz`, always the latest), `baka-mcp-server-<version>.tgz`, `baka-core-<version>.tgz`, `install.sh` and `moralo.module.json`. The npm name `baka` is taken, so publishing to npm needs a scope the owner chooses (see `docs/PUBLISHING.md`); until then the tarballs are the install.

A fresh install has exactly one pack, `starter`, bundled inside it (see "Packs and where they come from").

## The handshake

```
baka version --json
```

```json
{
  "schema": "baka.handshake/1",
  "name": "baka",
  "version": "0.1.0",
  "contract": "1.0.0",
  "capabilities": ["errors.json", "health", "isolated", "..."],
  "node": "v24.0.0"
}
```

A host asks the install itself whether it is compatible, instead of comparing version strings:

```
baka version --json --require-contract 1 --require recipes.run --require slots.supply
```

It prints the handshake and exits `0` when the contract major matches and every named capability is present. Otherwise it exits `3` and prints the error document with code `incompatible` and a hint saying which way to move. `--require` is repeatable.

| Capability | Meaning |
| --- | --- |
| `recipes.run` | `baka run` writes a recipe's files and returns a receipt. |
| `recipes.dry-run` | `--dry-run` computes the changeset and the tree hash and writes nothing. |
| `recipes.bare-name` | A recipe is named without its pack when one pack declares it. |
| `slots.supply` | The caller passes slot values (`--slot id=value`, `--slots-file`, `slots.values`). |
| `slots.open-report` | A run with no value and no model for a slot stops and lists the open slots. |
| `slots.replay` | Slot records (a receipt's `slots`) replay a run with no model. |
| `slots.pin` | `baka fill` pins a slot's fill in the project's slot cache. |
| `llm.per-call` | A model is passed with the call (`--llm-*`, `llm`, `BAKA_LLM_*`). |
| `isolated` | `--isolated` / `BAKA_ISOLATED=1`: nothing is read from the user directory. |
| `packs.dirs` | The packs come from directories the caller names (`--packs-dir`, `BAKA_PACK_DIRS`, `packDirs`). |
| `packs.bundled` | The `starter` pack ships inside the install. |
| `packs.lock` | `baka lock` pins packs by version and content hash; runs are held to the pins. |
| `packs.manifest` | `baka pack manifest` writes and checks the `moralo.module.json` of a repository of packs. |
| `schemas` | `baka schema` prints the JSON Schema of every document. |
| `errors.json` | Failures are `baka.error/1` on stdout under `--json`. |
| `health` | `baka health` says whether the install can do its job. |
| `serve` | `baka serve` exposes the same documents over HTTP (browser pages on other origins only when named with `--allow-origin` / `BAKA_ENGINE_ALLOWED_ORIGINS`, and then with a bearer token). |
| `addons` | A call can name add-ons (`--addon`, `BAKA_ADDONS`, `addons`): see "Add-ons". |

`baka health --json` prints `baka.health/1` (`ok` and the `checks` behind it) and exits `3` when `ok` is false. The exit code is part of the answer.

## Exit codes

The same four everywhere, for every command:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The command ran and the work failed: a validator said no, a target exists, slots are still open, a pin does not match. |
| `2` | Bad input: a flag, a path, a recipe or slot that does not exist, parameters that do not fit. |
| `3` | Not available or incompatible: the model could not be reached, the install is unhealthy, the handshake requirement is not met. |

A failed run has two shapes. A run that started and failed returns its **receipt** (`ok: false`, a diagnostic whose `rule` says why, and `openSlots` when slots are open) with exit `1`, or `2` when the rule says the caller named something wrong (`pack-not-found`, `recipe-not-found`, `recipe-ambiguous`, `invalid-params`, `slot-unknown`), or `3` for `slot-provider-error`. A request that could not even start returns the **error document**.

## Errors

```json
{ "error": { "code": "recipe-not-found", "message": "no installed pack declares a recipe \"nope\"; installed: starter/add-contributing, starter/add-editorconfig, ..." } }
```

`baka.error/1`. With `--json` it goes to stdout, and the message also goes to stderr as `baka: <message>`. `hint` is optional (`incompatible`, `manifest-missing` and `manifest-stale` carry one). `code` is a stable kebab-case word: `bad-request`, `unauthorized`, `forbidden`, `not-found`, `unavailable`, `incompatible`, `addon-invalid`, `unknown-schema`, `pack-dirs-invalid`, `manifest-missing`, `manifest-stale`, and every recipe error code (`recipe-not-found`, `recipe-ambiguous`, `pack-not-found`, `invalid-params`, `slots-open`, `lock-mismatch`, ...). Nothing falls back silently.

Over HTTP the same document comes with the matching status (`400`, `401`, `403`, `404`, `501`).

## Calls

A recipe is named `<recipe>`, or `<pack>/<recipe>` when two packs declare the same recipe. A bare name that two packs declare is refused with `recipe-ambiguous`, listing the candidates.

| Command | Returns |
| --- | --- |
| `baka list-packs --json` | `baka.catalog/1`: every pack, its recipes, their params (and each as a JSON Schema), the receipt's JSON Schema, discovery diagnostics. |
| `baka run <recipe> --json` | `baka.receipt/1`. |
| `baka slots <recipe> --json` | `baka.slot-list/1`: the slots the recipe's templates leave to fill. |
| `baka inspect <recipe> --json` | `baka.preview/1`: params, slots and template sources. |
| `baka fill <recipe> --slot <id> --value <text> [params] --json` | `baka.fill/1`: the slot cache path written. The params are the run's: the cache is keyed by them. |
| `baka lock [packs...] --json` | `{ path, lock }`; the file is `baka.lock/1`. |
| `baka version --json` | `baka.handshake/1`. |
| `baka health --json` | `baka.health/1`. |
| `baka schema [id]` | The ids, or one JSON Schema. |
| `baka pack manifest [dir]` | The `moralo.module.json` of a repository of packs. |

`baka run` takes the recipe's params as flags (`--name my-app`) or `--params '{"name":"my-app"}'`, plus `--dry-run`, `--on-existing skip|overwrite|fail`, `--no-validate`, `--format`, `--include-content`. The same call over HTTP is `POST /v1/run` with `{ recipe, pack?, params, slots?, llm?, dryRun?, onExisting?, validate?, format?, includeContent? }`; `GET /v1/packs`, `GET /v1/slots?recipe=`, `GET /v1/preview?recipe=` and `POST /v1/fill` match the rest. From the library: `runRecipe`, `describePacks`, `listRecipeSlots`, `previewRecipe`.

`plan`, `apply`, `validate`, `install`, `uninstall`, `search`, `registry`, `publish`, `org`, `role` and `init` are **not** part of contract 1: they work, and they may change.

### Determinism

The same recipe, params, slot values and packs write the same bytes, and `outputTreeHash` (sha256 over the sorted path and content hash of the changeset) says so. A receipt records everything a run used: `pins` (each pack's version and content hash) and `slots` (every slot's value, where it came from, and the model if one wrote it). Passing a receipt's `slots` back with `--slot-records receipt.json` replays the run with no model.

## Slots without a model

A slot has a value from, in this order: the caller (`slots.values`), the slot cache, a replayed record, or a model. A run that reaches a slot with none of them **writes nothing** and returns its receipt with `ok: false`, the diagnostic `slots-open`, and `openSlots`: each open slot's `id`, `kind`, `hint`, `file` and `templateKey` (the key a replay record for it must carry). The caller supplies values and runs again:

```bash
baka run write --title Probe --json                 # exit 1, openSlots: [{ "id": "line", ... }]
baka run write --title Probe --slot "line=A short note." --json     # exit 0
```

Values the caller supplies are used as given for that call, validated against the slot's kind, never cached, and need no model. A value for a slot the recipe does not declare is `slot-unknown` (exit `2`).

## Per-call configuration

Nothing a call needs has to live in the user's home directory. A host passes it with the call; the environment variable is for a host that launches Baka and cannot change its arguments.

| Setting | Flag | Environment | HTTP / library |
| --- | --- | --- | --- |
| Project root | `--cwd <dir>` | | `project` / `root` |
| Pack directories | `--packs-dir <dir>` (repeatable) | `BAKA_PACK_DIRS` | `packDirs` |
| Read nothing from `~/.baka` | `--isolated` | `BAKA_ISOLATED=1` | `isolated` |
| Model endpoint | `--llm-base-url <url>` | `BAKA_LLM_BASE_URL` | `llm.baseUrl` |
| Model name | `--llm-model <name>` | `BAKA_LLM_MODEL` | `llm.model` |
| Key, by variable name | `--llm-api-key-env <VAR>` | | `llm.apiKeyEnv` |
| Key itself | `--llm-api-key <key>` | `BAKA_LLM_API_KEY` | `llm.apiKey` |

The model is `baka.llm-call/1`: `baseUrl`, `model`, `apiKey`, `apiKeyEnv`, `temperature`, `maxTokens`, `timeoutMs`, `seed`. Prefer `apiKeyEnv`: the key stays out of argv and out of `ps`. A call that names a base URL and a model is complete on its own (a local server needs no key). Fields the call leaves out come from the user's stored model (`baka init`) unless `isolated`. An `apiKeyEnv` that names an unset variable fails the call, `bad-request`, naming the variable.

**`--isolated` guarantees** that a call reads nothing from `${BAKA_HOME:-$HOME/.baka}`: no user packs, no stored model, no user slot cache. What it does is then decided by its flags, its environment, the project's own files (`packs/`, `.baka/`, `baka.lock.json`) and the bundled `starter` pack. Several hosts and projects can use one install side by side without seeing each other.

A runner that scrubs the environment (Moralo does) passes `BAKA_ISOLATED=1` and the model as flags or `BAKA_LLM_*`; that is all Baka asks for.

## Packs and where they come from

Highest precedence first: the directories the caller names (`--packs-dir`, `BAKA_PACK_DIRS`, the project's `.baka/settings.json` `packDirs`; when given, **only** these), then the project's `.baka/packs` and `packs/`, then the user marketplace (`~/.baka/packs`, not with `--isolated`), then the bundled `starter` pack. The first scope that has a pack name owns it. Details are in `docs/PACKS.md`.

The `starter` pack: `add-readme`, `add-gitignore`, `add-mit-license`, `add-editorconfig`, `add-contributing`, `add-security-policy`, `add-node-ci`, `ts-lib`. Every file is a plain template, so none needs a model.

### Sharing a pack

A pack is shared by putting it in a git repository (the pack at the root, or several packs as subdirectories) and giving the repository a `moralo.module.json`:

```bash
baka pack manifest --write       # writes moralo.module.json from the packs and package.json
baka pack manifest --check       # exit 1 when the file no longer matches the packs (for CI)
```

The file declares `kinds: ["pack"]`, one runnable node per recipe (`result: baka.receipt/1`, `reproducible: true`), the permissions a recipe needs, and `requires.baka`. The author owns `id`, `name`, `summary`, `publisher`, `license`, `source` and `docs` (kept when the file is regenerated); everything that follows from the packs is generated. Anyone can install the repository: `baka install git:github.com/owner/repo@tag`. Listing it on a hub is the host's concern.

## Add-ons

The one extension point of the open engine, for packages that are not part of it (the paid options in `COMMERCIAL.md` are such packages). An add-on is an object with a `name` and either hook:

```ts
interface BakaAddon {
  name: string
  beforeRun?(request: { pack, recipe, params, pin, dryRun, root }): void | Promise<void>
  afterRun?(receipt: RecipeResult): void | Promise<void>
}
```

- `beforeRun` runs once the pack is found, pinned and its params are valid, before any slot is filled or file written. Throwing refuses the run: the receipt is `ok: false` with the diagnostic `addon-refused` (`<add-on name>: <message>`), exit `1`, and nothing is written.
- `afterRun` sees every receipt, a refused or failed one included. It cannot change the result. If it throws, the receipt gains the warning `addon-failed` and the run's outcome stands.
- An add-on is named by the caller, never discovered: `--addon <module-or-package>` (repeatable) or `BAKA_ADDONS` (separated like `PATH`) for the command and for `baka-mcp`, `addons` on `createEngineApp` and on `runRecipe` in the library. The module's default export is the add-on, or a function returning one. A module that cannot be loaded ends the command as bad input (`addon-invalid`, exit `2`).
- The open code never loads, looks for or checks a license for an add-on. What an add-on verifies, and how, is its own business.

## Documents

`baka schema` lists the ids; `baka schema <id>` prints the JSON Schema (draft-07). The same files ship in `@baka/core` under `schemas/`, and a test fails if they drift from the code.

| Id | What it is |
| --- | --- |
| `baka.receipt/1` | What `baka run` returns: `ok`, `pack`, `recipe`, `params`, `diagnostics`, `changeset`, `outputTreeHash`, `pins`, `slots`, `openSlots`, `compensation`, `output`, `dryRun`. |
| `baka.pin/1` | A pack as a run used it: `id`, `version`, `contentHash`. |
| `baka.lock/1` | `baka.lock.json`: `lockfileVersion` and the pinned packs. |
| `baka.catalog/1` | `baka list-packs --json`. |
| `baka.slot-list/1` | `baka slots --json`. |
| `baka.preview/1` | `baka inspect --json`. |
| `baka.fill/1` | `baka fill --json`. |
| `baka.slots-input/1` | The `slots` a run takes: `mode`, `records`, `values`. |
| `baka.llm-call/1` | The model passed with a call. |
| `baka.error/1` | `{ error: { code, message, hint? } }`. |
| `baka.handshake/1` | `baka version --json`. |
| `baka.health/1` | `baka health --json`. |

## The Moralo manifest

`moralo.module.json` at the root of this repository follows the module manifest (draft v0). It declares the `cli`, `mcp`, `http` and `library` transports, a runnable `run-recipe` node (`result: baka.receipt/1`, `reproducible: true`), the agent tools, the permissions and `env: { BAKA_ISOLATED: "1" }` for a runner. Where the draft was silent, the choices made are listed in the notes for the Moralo thread.

## Changelog

### 1.1.0

Add-ons (`addons` capability): `--addon`, `BAKA_ADDONS`, the `addons` option, the `addon-refused` error code and the `addon-failed` warning. Additive; every 1.0.0 call behaves as before.

### 1.0.0

First published contract. Recipes and packs replace actions and modules. Exit codes are `0` / `1` / `2` / `3`. Errors are `baka.error/1`. Documents carry ids. The handshake, health, schema and pack manifest commands, supplied slot values and open-slot reports, per-call model and `--isolated`, the bundled `starter` pack.
