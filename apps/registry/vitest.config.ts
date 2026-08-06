import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Some suites (notably the ingest-worker end-to-end stack)
		// run a real PGlite socket + polling worker, which needs
		// well over the 5s default per test. Tests that do
		// multiple publishes can compound waits, so we set a
		// generous per-test ceiling.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Each test file spins up its own PGlite + socket +
		// Better-Auth stack on ephemeral ports. Running them
		// in parallel puts several pglite-socket servers on the
		// same host contending for /tmp inode space and TCP
		// ports — observed flakiness on macOS runners. Run
		// one test file at a time.
		fileParallelism: false,
	},
})
