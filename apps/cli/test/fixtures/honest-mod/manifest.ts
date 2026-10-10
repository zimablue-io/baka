import type { PackManifest } from "baka-sdk"

export const Manifest: PackManifest = {
	name: "honest-mod",
	version: "0.0.0",
	description: "Param-only fixture used by determinism e2e. No LLM slots.",
	dependencies: [],
	conflictsWith: [],
	recipes: [
		{
			id: "write",
			description: "Write a marker file to the project root.",
			requiresReasoning: false,
			filePatterns: ["marker.txt"],
			validators: [],
			params: [],
		},
	],
	packValidators: [],
}
