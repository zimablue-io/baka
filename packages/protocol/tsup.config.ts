import { defineConfig } from "tsup"

// The contract package is a leaf: zod is its only dependency and it bundles nothing from the workspace.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	// The published manifest says "type": "module" (see publishConfig), so the bundle is plain .js (the type bundle is renamed to .d.ts by the build script).
	outExtension: () => ({ js: ".js" }),
	outDir: "dist",
	clean: true,
	sourcemap: true,
	minify: false,
	splitting: false,
	tsconfig: "tsconfig.build.json",
	dts: true,
	external: ["zod"],
})
