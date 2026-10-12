import { defineConfig } from "tsup"

// What a pack author installs. `@baka/protocol` stays a real dependency, so the types a pack sees are the very
// ones a host sees; the agent package (LLM role config) is bundled in and is not published on its own.
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
	dts: { resolve: true },
	external: ["zod", "@baka/protocol"],
	noExternal: [/^@baka\/agent$/],
})
