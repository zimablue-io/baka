import type { PackManifest } from "baka-sdk"

/**
 * The starter pack: small, fully deterministic recipes that need no model.
 * Every file is a plain template, so `baka run <recipe>` works on a fresh
 * install and the same parameters always write the same bytes.
 */
export const Manifest: PackManifest = {
	name: "starter",
	version: "0.1.0",
	description: "Everyday project files and a TypeScript library skeleton. Deterministic; no model needed.",
	dependencies: [],
	conflictsWith: [],
	recipes: [
		{
			id: "add-readme",
			description: "Write a README.md with the project name and a one-line description.",
			requiresReasoning: false,
			filePatterns: ["README.md"],
			validators: [],
			params: [
				{ name: "name", type: "string", required: true, description: "Project name.", minLength: 1, maxLength: 100 },
				{
					name: "description",
					type: "string",
					required: false,
					default: "",
					description: "One sentence on what the project does.",
					maxLength: 300,
				},
			],
		},
		{
			id: "add-gitignore",
			description: "Write a .gitignore for a Node.js or TypeScript project.",
			requiresReasoning: false,
			filePatterns: [".gitignore"],
			validators: [],
			params: [],
		},
		{
			id: "add-editorconfig",
			description: "Write an .editorconfig: UTF-8, LF, final newline, two-space indent.",
			requiresReasoning: false,
			filePatterns: [".editorconfig"],
			validators: [],
			params: [],
		},
		{
			id: "add-mit-license",
			description: "Write a LICENSE file with the MIT license text.",
			requiresReasoning: false,
			filePatterns: ["LICENSE"],
			validators: [],
			params: [
				{
					name: "holder",
					type: "string",
					required: true,
					description: "Copyright holder.",
					minLength: 1,
					maxLength: 100,
				},
				{
					name: "year",
					type: "string",
					required: true,
					description: "Copyright year, four digits. Given explicitly so the output never depends on the date.",
					pattern: "^[0-9]{4}$",
				},
			],
		},
		{
			id: "add-contributing",
			description: "Write a short CONTRIBUTING.md: how to propose a change.",
			requiresReasoning: false,
			filePatterns: ["CONTRIBUTING.md"],
			validators: [],
			params: [
				{ name: "name", type: "string", required: true, description: "Project name.", minLength: 1, maxLength: 100 },
			],
		},
		{
			id: "add-security-policy",
			description: "Write a SECURITY.md that says how to report a vulnerability.",
			requiresReasoning: false,
			filePatterns: ["SECURITY.md"],
			validators: [],
			params: [
				{
					name: "contact",
					type: "string",
					required: true,
					description: "Where to send reports: an email address or a URL.",
					minLength: 1,
					maxLength: 200,
				},
			],
		},
		{
			id: "add-node-ci",
			description: "Write a GitHub Actions workflow that installs, tests and builds a Node.js project.",
			requiresReasoning: false,
			filePatterns: [".github/workflows/ci.yml"],
			validators: [],
			params: [
				{
					name: "nodeVersion",
					type: "string",
					required: false,
					default: "22",
					description: "Node.js major version to test on.",
					pattern: "^[0-9]{2}$",
				},
				{
					name: "pnpm",
					type: "boolean",
					required: false,
					default: false,
					description: "Use pnpm instead of npm.",
				},
			],
		},
		{
			id: "ts-lib",
			description: "Scaffold a TypeScript library: package.json, tsconfig.json, src/index.ts, a test, README.md.",
			requiresReasoning: false,
			filePatterns: ["package.json", "tsconfig.json", "src/index.ts", "src/index.test.ts", "README.md"],
			validators: [],
			params: [
				{
					name: "name",
					type: "string",
					required: true,
					description: "npm package name.",
					format: "package-name",
				},
				{
					name: "description",
					type: "string",
					required: false,
					default: "",
					description: "One sentence on what the library does.",
					maxLength: 300,
				},
			],
		},
	],
	packValidators: [],
}
