import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		// `test/**/*.test.ts` is for cross-package integration probes
		// (e.g. dogfood regression tests that spawn the built CLI from a
		// sibling project cwd). The per-file-unit tests live in `src/`.
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/index.ts"],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 70,
				statements: 80,
			},
		},
	},
})
