import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/index.ts",
				"src/commands/init.ts",
				"src/commands/config.ts",
				"src/commands/marketplace.ts",
				"src/commands/plan.ts",
				"src/commands/providers.ts",
			],
			thresholds: {
				lines: 70,
				functions: 70,
				branches: 60,
				statements: 70,
			},
		},
	},
})
