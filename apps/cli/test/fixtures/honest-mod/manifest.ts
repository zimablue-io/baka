import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
	name: "honest-mod",
	version: "0.0.0",
	description: "Param-only fixture used by determinism e2e. No LLM slots.",
	dependencies: [],
	conflictsWith: [],
	actions: [
		{
			id: "write",
			description: "Write a marker file to the project root.",
			requiresReasoning: false,
			filePatterns: ["marker.txt"],
			validators: [],
			params: [],
		},
	],
	moduleValidators: [],
}
