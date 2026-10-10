import type { PackManifest } from "baka-sdk"

export const Manifest: PackManifest = {
	name: "vite-app",
	version: "0.1.0",
	description: "Writes a Vite + TypeScript app shell (package.json, tsconfig, vite config, index.html, src/main.ts).",
	dependencies: [],
	conflictsWith: [],
	recipes: [
		{
			id: "write",
			description: "Write the Vite+TS project shell. Home copy lives in named slots on src/main.ts.",
			requiresReasoning: true,
			filePatterns: ["package.json", "tsconfig.json", "vite.config.ts", "index.html", "src/main.ts"],
			validators: [],
			params: [
				{
					name: "name",
					type: "string",
					required: true,
					description: "npm package name (kebab-case) and UI brand",
				},
			],
		},
	],
	packValidators: [],
}
