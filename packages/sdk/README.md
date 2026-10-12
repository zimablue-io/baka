# @baka/sdk

What a pack author imports. Packs use it for **types only** (`import type { ... } from "@baka/sdk"`): Baka erases those imports when it loads a pack, so a pack needs no install of its own. A few helpers (`callLLMAsValidator`, `createLLMProvider`) are there for packs that opt into installing the SDK as a dependency.

```ts
import type { RecipeStep } from "@baka/sdk"

export const step: RecipeStep<{ name: string }> = {
	// ...
}
```

It depends on `@baka/protocol`, so the types a pack sees are the ones a host sees. See the [main README](https://github.com/zimablue-io/baka#readme) for packs, recipes and slots. Licensed under Apache-2.0.
