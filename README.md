
## Usage

### Development

To trigger workflows interactively, use the CLI:

```bash
# Plan a new feature
pnpm cli plan "<intent>"

# Scaffold a new module
pnpm cli scaffold "<module_name>"
```

#### CLI Alias
Add this to your `.bashrc` or `.zshrc` for quick access:

```bash
alias pi-cli='pnpm --prefix apps/cli run cli --'
```

### Creating a Test Module
To verify the engine, create a test module:
```bash
pi-cli scaffold test-module
```

## Technical Specifications
- Monorepo Engine: Turborepo managed with strict pnpm workspaces. 
- Runtime Dependency: Node.js (v20+) or Bun running entirely via native local script invocation.
- Target Core Stack: TypeScript, Next.js v16, Turborepo, Shadcn UI + Radix Base UI, Tailwind CSS.
- Target Domain Additions: Better-Auth, Neon DB, Supabase Storage, Sanity CMS.

## Directory Architecture
```
.
├── apps/
│   └── cli/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts
├── workflows/
│   ├── feature-planning/
│   │   └── plan-intent.ts
│   └── module-management/
│       └── create-module.ts
├── packages/
│   ├── protocol/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── constants.ts
│   │       ├── schemas.ts
│   │       └── types.ts
│   ├── agent-engine/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   └── ast-tooling/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts
├── modules/
│   └── README.md
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## Multi-Agent Architecture Specification (AGENTS.md)
This document defines the roles, bounded actions, stream constraints, and validation boundaries of the intelligent routing plane.

## Agent System Overview
The system operates on an isolated, deterministic execution loop. Agents do not write free-form code into user workspaces. Instead, they act as state-transition functions that parse user intent, match it against static structural schemas inside the modules/ folder, and return precise, validated JSON execution blocks.

## The Agent Topology
```
                  +-----------------------+
                  |  Human Prompt Input   |
                  +-----------+-----------+
                              |
                              v
                  +-----------------------+
                  |      Orchestrator     |
                  +-----------+-----------+
                              |
            +-----------------+-----------------+
            |                                   |
            v                                   v
+-----------------------+           +-----------------------+
|  Gemma Action Router  |           |   Pattern Verifier    |
| (Context Compacted)   |           |  (Grammar Constraint) |
+-----------------------+           +-----------------------+
```

## Agent Definitions
1. The Context-Compacted Action Router
- Core Model Variant: gemma4:e4b (or equivalent lightweight local model runner).
- System Boundary: Zero raw text generation allowed. Must stream outputs wrapped inside forced grammar boundaries or strict JSON objects matching the structural JSON validation schema.
- Responsibilities:
  - Ingest the compiled metadata maps from modules/*/manifest.ts.
  - Traverse the target application tree to map module requirements.
  - Emit an immutable sequence of step IDs and parameters matching exactly what the module scripts expect.

2. The Structural Pattern Verifier
- Core Model Variant: Fast, low-latency utility model combined with a native Abstract Syntax Tree (AST) checker.
- System Boundary: Operates exclusively post-execution.
- Responsibilities:
  - Analyze the generated system code modification before saving changes to disk.
  - Compare the output layout structurally against the module's blueprint definitions.
  - Provide feedback metrics to the top-level orchestration workflow if a step needs compensation/rollback.

## Context Compaction and Stream Bounding
To run this safely on a lightweight local engine, the system utilizes strict operational limits:
1. Token Pruning: The directory structure is passed as a flat dependency tree definition string. Raw code contents are never fed to the planning model.
2. Grammar Forcing: Output generation is locked directly to regex parameters via the execution runtime. If the model attempts to generate a conversational explanation (e.g., "Sure, I can help you add that module..."), the token validation system aborts the execution frame and re-evaluates the query.