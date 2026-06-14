Monorepo Architecture

This layout strictly separates the **Engine Framework** (Packages), the **Engine Orchestration** (Workflows), and the **Developer's Lego Blocks** (Modules).

```text
my-action-repo/
├── apps/
│   └── cli/                # Terminal interface: Triggers root workflows
│
├── workflows/              # ENGINE LOGIC: High-level orchestration for THIS project
│   ├── module-management/  # Workflows for creating/updating modules
│   └── feature-planning/   # Workflows for Gemma interaction & plan verification
│
├── packages/               # ENGINE TOOLS: The hidden functional nodes
│   ├── protocol/           # SSOT: Enums, Zod Schemas, Workflow Step Interfaces
│   ├── agent-engine/       # Node: Interaction logic with Gemma 4
│   └── ast-tooling/        # Node: Physical file manipulation utilities
│
├── modules/                # THE LEGO BLOCKS: What the end-user assembles
│   ├── next-base/          # Pattern: Standard Next.js v16 structure
│   ├── auth/               # Pattern: Better-Auth + Middleware
│   └── frontend-ui/        # Pattern: Shadcn + Tailwind
│
├── pnpm-workspace.yaml
└── turbo.json

```

---

## The SSOT Protocol (`packages/protocol`)

To keep everything DRY, we define the **Internal System Actions** here. These are the "System Calls" for your OS.

```typescript
// packages/protocol/src/system-actions.ts

// Enums for the engine's own internal operations
export const SYSTEM_WORKFLOW_ID = {
  CREATE_NEW_MODULE: 'CREATE_NEW_MODULE',
  PROCESS_USER_INTENT: 'PROCESS_USER_INTENT',
  VERIFY_WORKSPACE_HEALTH: 'VERIFY_WORKSPACE_HEALTH',
} as const;

export type SystemWorkflowId = typeof SYSTEM_WORKFLOW_ID[keyof typeof SYSTEM_WORKFLOW_ID];

// The contract for any "Step" in our Workflows
export interface EngineStepResponse<TOutput> {
  success: boolean;
  output: TOutput;
  error?: string;
}

```

---

## Why This Architecture Wins

1. **Workflows are Metadata:** By keeping `workflows/` at the root, you treat the logic of "how this engine works" as the primary feature.
2. **Modules are Data:** The Agent doesn't "know" how to code; it knows how to read the `modules/` manifests and suggest which `workflow/` to trigger.
3. **Strict Isolation:**
* If you change how Gemma works, you only touch `packages/agent-engine`.
* If you change the structure of a Better-Auth setup, you only touch `modules/auth`.
* If you change the *process* of how a new module is created, you only touch `workflows/create-module.ts`.
