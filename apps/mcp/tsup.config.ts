import { defineConfig } from "tsup"

// Bundle the workspace packages into the MCP binary. Same reasoning as the
// CLI's tsup config: without bundling, Node's strict ESM resolver cannot
// load the workflows' `index.ts` re-exports (`./X` without extension) when
// the user runs the built binary in pure Node (no tsx).
//
// `jiti` is left external because it uses CJS dynamic `require()` for
// Node built-ins (e.g. `os`), which cannot be inlined into an ESM bundle.
//
// Canonical build configuration (M4-F1):
// - Single ESM bundle (matches the `"type": "module"` package.json and the
//   `bin.baka-mcp` entry that points at dist/index.js).
// - Sourcemaps ON so JSON-RPC errors and structured stderr logs can be
//   traced back to source without bundling dev tools.
// - Minification OFF: keep readable stack frames and predictable startup.
// - Shebang: tsup auto-injects the `#!/usr/bin/env node` line that
//   appears at the top of `src/index.ts`.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	outDir: "dist",
	clean: true,
	sourcemap: true,
	minify: false,
	noExternal: [/^@repo\//],
	external: ["jiti"],
	splitting: false,
})
