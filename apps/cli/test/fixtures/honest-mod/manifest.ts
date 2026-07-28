import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
	name: "honest-mod",
	version: "0.0.0",
	description: "A minimal non-reasoning module used by the plan/apply honesty test fixtures.",
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
