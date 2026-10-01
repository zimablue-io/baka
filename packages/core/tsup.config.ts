import { defineConfig } from "tsup"

// The published package is self-contained: the private workspace packages
// (`@repo/*`) are bundled in, while real npm dependencies (handlebars, jiti,
// zod) stay external and are listed in `dependencies`. No provider SDK and no
// CLI code is reachable from this entry point; the caller injects an
// `LLMProvider`.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	outDir: "dist",
	clean: true,
	sourcemap: true,
	minify: false,
	splitting: false,
	tsconfig: "tsconfig.build.json",
	dts: { resolve: true },
	external: ["zod", "handlebars", "jiti"],
	noExternal: [/^@repo\//],
})
