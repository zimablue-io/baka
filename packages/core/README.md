# @baka/core

The embeddable Baka engine. Run a declared module action against a project directory, deterministically: files are templates, params interpolate, and an LLM fills named slots only. No CLI, no MCP server, no HTTP, and no process-global config.

```ts
import { createRegistry, describeModules, runAction, validate } from "@baka/core"

const registry = createRegistry({
	root: "/work/checkout", // where actions write
	moduleDirs: ["/opt/baka-modules"], // each holds <module>/manifest.ts
})

const catalog = describeModules(registry)

const result = await runAction({
	registry,
	module: "hello",
	action: "greet",
	params: { name: "Ada" },
	provider, // any LLMProvider; omit when every slot is already filled
	model: "gemma4:e4b",
})
```

## The receipt

`runAction` resolves to an `ActionResult` (it never throws for a failed run):

```ts
interface ActionResult {
	ok: boolean // false when any diagnostic is an error
	module: string
	action: string
	diagnostics: ValidationDiagnostic[] // a failed run carries one error whose `rule` is an ActionErrorCode
	changeset: ChangesetEntry[] // { path, op: "create" | "update" | "delete" | "unchanged" | "skip", contentHash, reason? }
	outputTreeHash: string // sha256 over the canonical (path, contentHash) list of every file the action owns
	slots: SlotRecord[]
	compensation: ActionCompensation // { created, createdDirs, overwritten, actionData }; feed to compensateAction() to undo the run
	output: unknown // what a side-effect action.ts returned, else null
	dryRun: boolean
}
```

## Slot records and replay

Slot fills come back as data in `result.slots`. Pass them back to reproduce a run with no model:

```ts
const recorded = await runAction({ registry, module: "hello", action: "greet", params, provider, model })
// ...store `recorded` anywhere...
const replayed = await runAction({
	registry,
	module: "hello",
	action: "greet",
	params,
	slots: { mode: "replay", records: recorded.slots }, // no provider
})
replayed.outputTreeHash === recorded.outputTreeHash // true
```

In `replay`, a missing slot fails the run with `slot-record-missing` and no model call is ever made. Modes `live` (cache then model, the default) and `record` (always the model) are described in [docs/MODULES.md](../../docs/MODULES.md#slot-records-and-replay).

`dryRun: true` computes the same receipt without writing a byte (template-only actions, and `action.ts` actions that declare `supportsDryRun` and write through `ctx.files`). The exact definition of `outputTreeHash`, the changeset ops, and the failure semantics are in [docs/MODULES.md](../../docs/MODULES.md#running-an-action-the-receipt).

## What `outputTreeHash` covers

The hash is over the **full set of files the action owns**, not just the ones that changed: every template target, every file an `action.ts` wrote or removed through `ctx.files` or declared with `ctx.files.own(...)`, and every file its `execute` created, changed, or deleted. A file that was already there with the right bytes is listed as `unchanged`. So a first run and a rerun over the same tree list the same paths with the same content hashes and have the same `outputTreeHash`; the changeset ops (`create` vs `unchanged`) are deliberately not hashed. `skip` entries hash the bytes on disk, so a rerun that left a differing file alone hashes differently from a fresh run, which is the point. Definition and the one gap (plain `node:fs` writes an action does not `own`): [docs/MODULES.md](../../docs/MODULES.md#outputtreehash).

## Side-effect actions (`action.ts`)

An `action.ts` exports an `ActionStep` (`execute(params, state, ctx)` and `compensate(data, state, ctx)`). `ctx` carries `onExisting`, `dryRun`, `module`, `projectRoot`, `llmProvider`, and a contained file API `ctx.files` (`exists`, `readText`, `write`, `remove`, `own`) whose writes honour `onExisting`, show up in the changeset (as `unchanged` on a rerun), run against a virtual tree in a dry run, and are undone by the engine if the run fails. A failed `action.ts` run is compensated by the engine: its `compensate` is called with the data `execute` returned, and every file and directory the run created is removed. See [docs/MODULES.md](../../docs/MODULES.md#the-actionts-contract).

## The catalog and JSON Schema

`describeModules(registry)` returns every module's actions with their param declarations, a JSON Schema (draft-07) per action in `paramsSchema`, and the receipt's schema in `resultSchema`; all of it is plain JSON. `runAction` validates params against the same declarations (defaults applied, numeric and boolean text coerced, string constraints checked, undeclared keys rejected with `invalid-params`). See [docs/MODULES.md](../../docs/MODULES.md#param-types-and-the-catalogs-json-schema).

## Reruns

`onExisting: "skip" | "overwrite" | "fail"` (default `skip`) decides what happens to template targets that already exist. The changeset reports each as `unchanged` (identical bytes), `skip` (other bytes, left alone), or `update` (rewritten), so a caller can tell "same tree" from "nothing happened": a rerun over its own output is all `unchanged` with the same `outputTreeHash`. See [docs/MODULES.md](../../docs/MODULES.md#rerunning-an-action).

## Templates and module data

A template is a small, fail-closed Handlebars subset with a few additions for generating real projects: a first-line `{{!-- @baka when="..." mode="0755" --}}` directive makes a file conditional on the params and sets its executable bit (`mode` is part of the receipt and the tree hash), `\{{` writes a literal `{{`, `{{json x}}` and `{{jsonEscape x}}` JSON-escape a value, and a module's `data/*.json` files are exposed read-only as `data.<name>` to templates and to `action.ts` (`ctx.data`). See [docs/MODULES.md](../../docs/MODULES.md#template-language).

## Containment

Nothing is ever written, read for a write decision, or deleted outside `root`. A template path rendered from params (`{{dir}}/{{name}}/...` with `name = ../../x`), an absolute path, a `..` segment, a path through `.git` or the root's `.baka/`, and a path through a symlink that leaves the root all fail the run with `path-escape` before the first write. Rollback (`compensateAction`) validates the paths of the compensation it is given and removes the directories the run created (`compensation.createdDirs`). Constrain string params in the manifest with `format` (`slug`, `path-segment`, `relative-path`, `identifier`, `package-name`), `pattern`, `minLength`, `maxLength`; they are enforced as `invalid-params` and exported in the JSON Schema. See [docs/MODULES.md](../../docs/MODULES.md#path-containment).

## Pinning

Each receipt's `pins` is `[{ id, version, contentHash }]` for the module the run used. `createLock(registry)` builds a `baka.lock.json` document; pass it back as `runAction({ lock })` and a module that is unlisted, or whose version or files changed, fails the run (`lock-unlisted` / `lock-mismatch`) before any model call or write. The hash definition and the file format are in [docs/MODULES.md](../../docs/MODULES.md#pinning-modules-and-bakalockjson).

`ModuleRegistry` is exported because `runAction` and friends take one, but build yours with `createRegistry`. To follow the CLI's choice of directories (the flag, `BAKA_MODULE_DIRS`, then the project's `.baka/settings.json` `moduleDirs`), pass `resolveModuleDirs({ root, env })` as `moduleDirs`; it throws `ModuleDirsError` for a listed directory that does not exist. Calling `new ModuleRegistry(root)` without `moduleDirs` is the default discovery: it also searches `<root>/modules`, `<root>/.baka/modules`, and the user marketplace under `${BAKA_HOME:-$HOME/.baka}`.

## What this package does not do

- It never reads `${BAKA_HOME:-$HOME/.baka}` (config, user marketplace, user slot cache). Modules come only from the directories you pass to `createRegistry`. The user-level slot cache is only consulted if you build a store with `createDiskSlotStore(root, { userFallback: true })`.
- It never imports an LLM vendor SDK. You inject an `LLMProvider` (the interface lives in this package's types: `name`, `chat`, `validateConfig`); the engine only ever asks it to fill a slot.
- It has no CLI concerns: no argv, no prompts, no exit codes.

## Install

`@baka/core` is not on a registry yet. Build a tarball and install it into any project (ESM only, Node 20 or newer):

```bash
# in the Baka repo
pnpm build --filter @baka/core && pnpm run pack      # writes dist-tarballs/baka-core-<version>.tgz

# in your project, outside the workspace
npm install /abs/path/to/baka/dist-tarballs/baka-core-<version>.tgz     # or: pnpm add file:/abs/path/...tgz
```

```ts
import { createRegistry, describeModules, runAction, validate } from "@baka/core"
```

Its three runtime dependencies are declared and install normally: `handlebars`, `jiti`, and `zod` (**4.x**: the `LLMRequest.responseSchema` type and the JSON Schema export are zod 4 schemas, and zod 4 generates JSON Schema itself through `z.toJSONSchema`, so no separate converter is shipped). The private workspace packages (`@repo/*`) are bundled into `dist/index.js`, so nothing else is needed; the tarball ships `dist/index.js`, `dist/index.d.ts`, the README, and the licence. Use `pnpm run pack` (`scripts/pack.mjs`), not a bare `pnpm pack`: a bare pack also carries the workspace's `devDependencies` (inert on install, but with made-up versions).

`node scripts/verify-core-pack.mjs` (`pnpm run verify:core`) proves the route end to end: it packs, installs the tarball with npm into a scratch project outside the repo, imports it, runs a module from a catalog directory against another project directory, and type-checks a consumer file against `index.d.ts`. CI runs it after the pack step.

Modules you run through it follow the same rule as with the CLI: they import `baka-sdk` for **types only** (`import type`), so a catalog needs no install of its own (see [docs/MODULES.md](../../docs/MODULES.md#public-boundary-baka-sdk)).
