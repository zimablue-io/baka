import type { ModuleManifest } from "baka-sdk"

export const Manifest: ModuleManifest = {
	name: "baka-base",
	version: "0.1.0",
	description: "Minimal hello-world TypeScript project scaffold. Use this as the foundation for any new app.",
	dependencies: [],
	conflictsWith: [],
	actions: [
		{
			id: "scaffold",
			description: "Create a fresh TypeScript project (package.json, tsconfig.json, src/index.ts, README.md).",
			requiresReasoning: false,
			filePatterns: ["package.json", "tsconfig.json", "src/index.ts", "README.md"],
			validators: ["hasConsoleLog"],
			params: [
				{ name: "name", type: "string", required: true, description: "Project name (kebab-case)." },
				{ name: "description", type: "string", required: false, description: "Short project description." },
				{ name: "moduleType", type: "enum", required: false, description: "Module system.", enumValues: ["esm", "commonjs"] },
			],
		},
		{
			id: "add-script",
			description: "Add or update a script entry in package.json. Idempotent.",
			requiresReasoning: false,
			filePatterns: ["package.json"],
			validators: [],
			params: [
				{ name: "name", type: "string", required: true, description: "Script name (e.g. 'build')." },
				{ name: "command", type: "string", required: true, description: "Script command (e.g. 'tsc')." },
			],
		},
		{
			id: "add-dependency",
			description: "Add a runtime or dev dependency to package.json with a pinned version range.",
			requiresReasoning: false,
			filePatterns: ["package.json"],
			validators: [],
			params: [
				{ name: "name", type: "string", required: true, description: "Package name (e.g. 'zod')." },
				{ name: "version", type: "string", required: true, description: "Version range (e.g. '^3.23.0')." },
				{ name: "dev", type: "boolean", required: false, description: "Add to devDependencies (default false)." },
			],
		},
	],
	moduleValidators: ["hasPackageJson", "tsconfigPresent"],
}
