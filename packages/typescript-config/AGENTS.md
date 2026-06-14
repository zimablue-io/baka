# Specialist Routing

- Primary: `reviewer`
- Support: `typescript_backend` for compiler-setting changes that affect shared package code.

# TypeScript Config Package Agent Guide

Scope: `packages/typescript-config`.

Read first:
- `README.md`
- `../../docs/AGENT.md`

Notes:
- This package has no package-local scripts in `package.json`.
- Change shared TS configs here only when multiple workspaces need the same compiler behavior.
