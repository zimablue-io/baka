import { ModuleEntrySchema, type ModuleEntry } from "@repo/protocol"

/**
 * One well-formed catalog entry for registry tests.
 * Production `BUILT_IN_CATALOG` stays empty; this is not shipped.
 */
export const TEST_CATALOG_MODULE: ModuleEntry = ModuleEntrySchema.parse({
	name: "hello",
	version: "0.1.0",
	description: "Tiny registry-test fixture. One greet action.",
	dependencies: [],
	conflictsWith: [],
	source: "git:github.com/baka-fixtures/hello@v0.1.0",
	actions: [
		{
			id: "greet",
			description: "Write a greeting",
			params: [{ name: "name", type: "string", required: true, description: "who" }],
			requiresReasoning: false,
			filePatterns: ["hello.md"],
			validators: [],
		},
	],
	moduleValidators: [],
})
