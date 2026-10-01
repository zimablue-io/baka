import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
	name: "slot-mod",
	version: "0.0.0",
	description: "One small prose slot. The live e2e bar is gemma4:e4b filling this hole.",
	dependencies: [],
	conflictsWith: [],
	actions: [
		{
			id: "write",
			description: "Write note.md from a skeleton with one named slot.",
			requiresReasoning: true,
			filePatterns: ["note.md"],
			validators: [],
			params: [{ name: "title", type: "string", required: true, description: "Document title" }],
		},
	],
	moduleValidators: [],
}
