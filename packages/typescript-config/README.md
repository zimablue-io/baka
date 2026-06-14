# @repo/typescript-config

## Overview

`@repo/typescript-config` provides the shared TypeScript presets used across South. It keeps compiler defaults aligned so each workspace only overrides behavior that is genuinely local.

## Directory Structure

```text
packages/typescript-config
|-- base.json
|-- nextjs.json
|-- react-library.json
|-- package.json
`-- README.md
```

## Key Responsibilities

- `base.json`: default preset for general packages and scripts.
- `nextjs.json`: preset for the Next.js application and any workspace that needs Next-specific compiler defaults.
- `react-library.json`: preset for React library packages such as shared UI.
- Changes here should only be made when multiple workspaces need the same compiler behavior.

## Getting Started

1. Use `base.json` for general packages, `nextjs.json` for Next.js work, and `react-library.json` for component libraries.
2. Change configs here only when the adjustment should be shared by multiple workspaces.
3. This package has no local scripts, so validate changes through consuming workspaces, typically with `pnpm run check:ci`.
