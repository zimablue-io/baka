# @baka/protocol

Baka's contract, and nothing else: the versioned documents a host exchanges with Baka (receipts, catalogs, handshake, errors), their JSON Schemas, the exit codes, the capability names and the shared TypeScript types. It depends on `zod` only, so a host (Moralo, a CI step, your own tool) can read and validate Baka's output without installing the engine.

```ts
import { BAKA_CONTRACT_VERSION, RecipeResultSchema, type RecipeResult } from "@baka/protocol"
```

What each Baka package is for:

| Package | Use it to |
| --- | --- |
| `@baka/protocol` | read and validate Baka's documents (this package) |
| `@baka/core` | run recipes from your own code |
| `@baka/sdk` | write packs |
| `@baka/cli` | run Baka from a terminal (`baka`) |
| `@baka/mcp` | give an agent the Baka tools (`baka-mcp`) |

The contract is described in [docs/CONTRACT.md](https://github.com/zimablue-io/baka/blob/main/docs/CONTRACT.md). Licensed under Apache-2.0.
