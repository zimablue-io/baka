# Implementation Roadmap: Agent-Driven Module Platform

## Phase 1: Foundation & Protocol Hardening
- **Goal:** Establish core types, schemas, and orchestration interfaces for deterministic system actions.
- **Key Tasks:**
  - Define/refine `packages/protocol` schemas for system actions, step responses, and worker task definitions.
  - Formalize `WorkflowStep` interface (including `compensate`).
  - Create the base `WorkflowSDK` engine for execution and state management.

## Phase 2: Agent-Engine Specialization (Tiered Architecture)
- **Goal:** Evolve `agent-engine` (SSOT) to support specialized agent roles without introducing new dependencies.
- **Key Tasks:**
  - Implement Tiered Agent logic within `agent-engine`:
    - **Planner:** High-reasoning LLM for intent analysis and plan decomposition.
    - **Worker:** Efficient, deterministic agents that map plans to pre-defined `modules/`.
    - **Validator:** Specialized agents for QA/Testing/Pattern validation.
  - Enforce schema-bound LLM interaction (Grammar-bound mapping) directly within `agent-engine`.
  - Eliminate RAG dependency by relying purely on module manifests for context.

## Phase 3: Workflow Orchestration & Migration
- **Goal:** Migrate workflows (`module-management`, `feature-planning`) to `WorkflowSDK` using specialized agent roles.
- **Key Tasks:**
  - Refactor workflows to use `agent-engine` roles (Planner -> Worker -> Validator).
  - Implement the `WorkflowEngine` to execute orchestrations.
  - Ensure compatibility with `apps/cli`.

## Phase 4: Module Ecosystem Expansion
- **Goal:** Solidify module-based implementation pattern.
- **Key Tasks:**
  - Finalize module manifest format (manifests, actions, pattern enforcement).
  - Implement module discovery service.
  - Document patterns for `next-base`, `auth`, `frontend-ui`.

## Phase 5: Refinement & Validation
- **Goal:** Ensure system stability and observability.
- **Key Tasks:**
  - Implement robust logging and observability in `WorkflowSDK`.
  - Validate atomic compensation logic for worker failures.
  - Finalize CLI user experience.
