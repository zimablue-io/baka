import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		// Run test files serially. Some smoke suites (notably
		// `baka-module-create.test.ts`) rebuild the CLI dist in beforeAll
		// via `tsup --clean`, which briefly deletes `apps/cli/dist/index.js`.
		// Other suites (cli-smoke, engine-smoke) spawn the dist as a
		// subprocess during their probes. Running files in parallel
		// exposes a MODULE_NOT_FOUND race; running serially eliminates it.
		fileParallelism: false,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/index.ts",
				"src/commands/init.ts",
				"src/commands/marketplace.ts",
				"src/commands/plan.ts",
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
