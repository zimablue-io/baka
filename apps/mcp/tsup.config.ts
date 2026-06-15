import { defineConfig } from "tsup"

// Bundle the workspace packages into the MCP binary. Same reasoning as the
// CLI's tsup config: without bundling, Node's strict ESM resolver cannot
// load the workflows' `index.ts` re-exports (`./X` without extension) when
// the user runs the built binary in pure Node (no tsx).
//
// `jiti` is left external because it uses CJS dynamic `require()` for
// Node built-ins (e.g. `os`), which cannot be inlined into an ESM bundle.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	outDir: "dist",
	clean: true,
	noExternal: [/^@repo\//],
	external: ["jiti"],
	splitting: false,
})
