import { defineConfig } from "tsup"

// Bundle the workspace packages into the CLI. Without this, tsup leaves
// `@repo/*` imports external, and Node's strict ESM resolver cannot load
// the workflows' `index.ts` re-exports (`./X` without extension) when the
// user runs the built CLI in pure Node (no tsx).
//
// `jiti` is left external because it uses CJS dynamic `require()` for
// Node built-ins (e.g. `os`), which cannot be inlined into an ESM bundle.
//
// Canonical build configuration (M4-F1):
// - Single ESM bundle (matches the `"type": "module"` package.json and the
//   `bin.baka` entry that points at dist/index.js).
// - Sourcemaps ON for debuggability without forcing the user to ship
//   unmangled stack traces.
// - Minification OFF: keep readable stack frames and predictable startup
//   time. The dist is small enough that minification isn't worth it.
// - Shebang: tsup auto-injects the `#!/usr/bin/env node` line that
//   appears at the top of `src/index.ts`.
// - No `external` list beyond `jiti`; everything else resolves through
//   the workspace install (where `workspace:*` deps are still in place).
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
