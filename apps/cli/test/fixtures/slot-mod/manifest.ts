import type { PackManifest } from "baka-sdk"

export const Manifest: PackManifest = {
	name: "slot-mod",
	version: "0.0.0",
	description: "One small prose slot. The live e2e bar is gemma4:e4b filling this hole.",
	dependencies: [],
	conflictsWith: [],
	recipes: [
		{
			id: "write",
			description: "Write note.md from a skeleton with one named slot.",
			requiresReasoning: true,
			filePatterns: ["note.md"],
			validators: [],
			params: [{ name: "title", type: "string", required: true, description: "Document title" }],
		},
	],
	packValidators: [],
}
