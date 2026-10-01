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
	outputTreeHash: string // sha256 over the canonical (path, contentHash) list
	slots: SlotRecord[]
	compensation: ActionCompensation // feed to compensateAction() to undo the run
	output: unknown // what a side-effect action.ts returned, else null
	dryRun: boolean
}
```

`dryRun: true` computes the same receipt without writing a byte. The exact definition of `outputTreeHash`, the changeset ops, and the failure semantics are in [docs/MODULES.md](../../docs/MODULES.md#running-an-action-the-receipt).

## What this package does not do

- It never reads `${BAKA_HOME:-$HOME/.baka}` (config, user marketplace, user slot cache). Modules come only from the directories you pass to `createRegistry`. The user-level slot cache is only consulted if you build a store with `createDiskSlotStore(root, { userFallback: true })`.
- It never imports an LLM vendor SDK. You inject an `LLMProvider` (the interface lives in this package's types: `name`, `chat`, `validateConfig`); the engine only ever asks it to fill a slot.
- It has no CLI concerns: no argv, no prompts, no exit codes.

## Install

`@baka/core` is built with tsup and packed with `pnpm run pack` (see `docs/PUBLISHING.md`). The tarball is self-contained ESM plus `index.d.ts`; `handlebars`, `jiti`, and `zod` are its runtime dependencies.
