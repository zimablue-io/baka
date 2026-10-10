import type { PackManifest } from "baka-sdk"

export const Manifest: PackManifest = {
	name: "vite-page",
	version: "0.1.0",
	description: "Writes one extra Vite HTML entry and its TypeScript module.",
	dependencies: [],
	conflictsWith: [],
	recipes: [
		{
			id: "write",
			description: "Write one extra Vite HTML entry and its TypeScript module.",
			requiresReasoning: true,
			filePatterns: ["{{slug}}.html", "src/{{slug}}.ts"],
			validators: [],
			params: [
				{
					name: "slug",
					type: "string",
					required: true,
					description: "URL slug, e.g. about (becomes about.html and src/about.ts)",
				},
				{
					name: "title",
					type: "string",
					required: true,
					description: "page heading",
				},
			],
		},
	],
	packValidators: [],
}
