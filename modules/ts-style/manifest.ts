import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
	name: "ts-style",
	version: "0.1.0",
	description:
		"TypeScript style enforcer. Bundles validators that block `any`, warn on console.log, and require explicit return types on exported functions.",
	dependencies: ["baka-base"],
	conflictsWith: [],
	actions: [
		{
			id: "install-config",
			description: "Drop a strict tsconfig.json and biome.json into the target project.",
			requiresReasoning: false,
			filePatterns: ["tsconfig.json", "biome.json"],
			validators: [],
			params: [
				{ name: "strict", type: "boolean", required: false, description: "Apply maximum strictness (default true)." },
			],
		},
		{
			id: "lint",
			description:
				"Run the project's linter (biome) and report findings. Stub for Phase 6; full impl wires the validator chain in Phase 8.",
			requiresReasoning: false,
			filePatterns: [],
			validators: [],
			params: [],
		},
	],
	moduleValidators: ["noAnyTypes", "noConsoleLog", "explicitReturnTypes"],
}
